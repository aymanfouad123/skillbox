import { Sandbox } from "@vercel/sandbox";
import { NextResponse, after } from "next/server";
import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { CLIProvider } from "../../../data/skills";
import {
  CLI_PROVIDERS,
  installCLI,
  installTTYD,
  injectSkill,
  launchTTYD,
  warmSandboxServicesInBackground,
  startDevServer,
  createSandboxWithSnapshotOrGit,
  resolvePlayground,
  OPENCODE_SNAPSHOT_SETUP_VERSION,
  triggerSnapshotRenewal,
} from "../../../lib/sandbox-utils";

// Lazy Convex client - only init when URL is set to avoid crash on missing env
let convexClient: ConvexHttpClient | null = null;
function getConvexClient(): ConvexHttpClient | null {
  if (convexClient !== null) return convexClient;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  convexClient = new ConvexHttpClient(url);
  return convexClient;
}

// =============================================================================
// Internal Secret Validation
// =============================================================================

function validateInternalSecret(request: Request): boolean {
  const secret = request.headers.get("X-Internal-Secret");
  const expectedSecret = process.env.CONVEX_INTERNAL_SECRET;

  const explicitBypass =
    process.env.ALLOW_INTERNAL_BYPASS === "true" ||
    process.env.SKILLBOX_ALLOW_INTERNAL_BYPASS === "true";

  if (!expectedSecret) {
    if (explicitBypass) {
      console.warn(
        "[internal route] Internal secret bypass active: expectedSecret is unset, NODE_ENV=%s",
        process.env.NODE_ENV ?? "undefined"
      );
      return true;
    }
    console.warn(
      "[internal route] CONVEX_INTERNAL_SECRET is not set; NODE_ENV=%s. Rejecting request.",
      process.env.NODE_ENV ?? "undefined"
    );
    return false;
  }

  if (secret === null || secret === "") {
    return false;
  }

  const hashIncoming = crypto
    .createHash("sha256")
    .update(secret, "utf8")
    .digest();
  const hashExpected = crypto
    .createHash("sha256")
    .update(expectedSecret, "utf8")
    .digest();

  if (hashIncoming.length !== hashExpected.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashIncoming, hashExpected);
}

// =============================================================================
// Request Body Interface
// =============================================================================

interface CreateSandboxRequest {
  skillOwner: string;
  skillRepo: string;
  skillName: string;
  targetOwner: string;
  targetRepo: string;
  cliProvider?: CLIProvider;
  anthropicApiKey?: string;
}

// =============================================================================
// POST Handler - Create Sandbox (Internal use by Convex)
// =============================================================================

export async function POST(request: Request) {
  // Validate internal secret
  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let sandbox: Sandbox | null = null;
  let success = false;

  try {
    const body: CreateSandboxRequest = await request.json();
    const {
      skillOwner,
      skillRepo,
      skillName,
      targetOwner,
      targetRepo,
      cliProvider = "opencode",
      anthropicApiKey,
    } = body;

    // Validation
    if (
      !skillOwner ||
      !skillRepo ||
      !skillName ||
      !targetOwner ||
      !targetRepo
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (cliProvider === "claude" && !anthropicApiKey) {
      return NextResponse.json(
        { error: "Anthropic API key is required for Claude CLI" },
        { status: 400 }
      );
    }

    const provider = CLI_PROVIDERS[cliProvider];

    // 1. Resolve playground and snapshot from Convex only (prefer compatible prebaked for OpenCode)
    const { playground } = resolvePlayground(targetOwner, targetRepo);
    let snapshotId: string | null = null;
    let usedCompatibleOpencodeSnapshot = false;
    const convex = getConvexClient();
    if (playground && convex) {
      try {
        if (cliProvider === "opencode") {
          const compatible = await convex.query(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (api as any).snapshots?.getCompatibleSnapshot,
            {
              playgroundId: playground.id,
              flavor: "opencode",
              setupVersion: OPENCODE_SNAPSHOT_SETUP_VERSION,
            }
          );
          if (compatible?.snapshotId) {
            snapshotId = compatible.snapshotId;
            usedCompatibleOpencodeSnapshot = true;
            console.log(`[Internal] Using compatible OpenCode snapshot: ${snapshotId}`);
          }
        }
        if (!snapshotId) {
          const convexSnapshot = await convex.query(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (api as any).snapshots?.getSnapshot,
            { playgroundId: playground.id }
          );
          if (convexSnapshot?.snapshotId) {
            snapshotId = convexSnapshot.snapshotId;
            console.log(`[Internal] Using Convex snapshot: ${snapshotId}`);
          }
        }
      } catch (err) {
        console.log("[Internal] Convex snapshot query failed, using fallback:", err);
      }
    }

    console.log(
      snapshotId
        ? `[Internal] Creating sandbox from snapshot (${playground?.id}), skill ${skillName}, using ${provider.name}...`
        : `[Internal] Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}, using ${provider.name}...`
    );

    // 2. Create Sandbox (shared helper with snapshot fallback)
    const { sandbox: createdSandbox, snapshotUsed } =
      await createSandboxWithSnapshotOrGit({
        targetOwner,
        targetRepo,
        snapshotId,
        logPrefix: "[Internal] ",
      });
    sandbox = createdSandbox;

    if (playground && (!snapshotId || !snapshotUsed)) {
      // No snapshot existed or snapshot boot failed — create one for next time
      const renewalPromise = triggerSnapshotRenewal(playground.id, playground.owner, playground.repo).catch(
        (err) => console.warn("[Internal] Renewal trigger failed:", err)
      );
      after(renewalPromise);
    }

    const skipOpencodeInstall =
      cliProvider === "opencode" && usedCompatibleOpencodeSnapshot && snapshotUsed;

    // 3. Install CLI (skip when prebaked OpenCode snapshot was used)
    if (!skipOpencodeInstall) {
      await installCLI(sandbox, provider);
    } else {
      console.log("[Internal] Skipping OpenCode CLI install (prebaked snapshot)");
    }

    // 4. Install TTYD
    const ttydPath = await installTTYD(sandbox);

    // 5. Inject the Skill
    await injectSkill(sandbox, skillOwner, skillRepo, skillName);

    // 6. Configure CLI (skip when prebaked OpenCode snapshot was used)
    if (!skipOpencodeInstall) {
      console.log(`Setting up ${provider.name} CLI configuration...`);
      await provider.configSetup(sandbox);
    } else {
      console.log("[Internal] Skipping OpenCode config (prebaked snapshot)");
    }

    // 7. Launch TTYD
    await launchTTYD(sandbox, ttydPath, provider, anthropicApiKey);

    // 8. Start dev server (detects project type)
    const devPort = await startDevServer(sandbox);
    const warmUpPromise = warmSandboxServicesInBackground(sandbox, devPort, {
      logPrefix: "[Internal] ",
      sandboxId: sandbox.sandboxId,
    });
    after(warmUpPromise);

    const ttydUrl = sandbox.domain(7681);
    // Expose preview URL immediately; readiness probes run in background.
    const previewUrl = sandbox.domain(devPort);
    console.log(`Sandbox ready: ${ttydUrl}${previewUrl ? `, preview: ${previewUrl}` : ""}`);

    success = true;
    return NextResponse.json({
      sandboxId: sandbox.sandboxId,
      ttydUrl,
      previewUrl,
      status: "ready",
      // Vercel timing for accurate countdown
      vercelCreatedAt: sandbox.createdAt.getTime(),
      vercelTimeout: sandbox.timeout,
    });
  } catch (error) {
    console.error("Internal sandbox creation failed:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to initialize",
      },
      { status: 500 }
    );
  } finally {
    if (sandbox != null && !success) {
      try {
        await sandbox.stop();
        console.log(`Stopped failed sandbox: ${sandbox.sandboxId}`);
      } catch (stopErr) {
        console.error("Failed to stop sandbox:", stopErr);
      }
    }
  }
}

// =============================================================================
// DELETE Handler - Stop Sandbox (Internal use by Convex)
// =============================================================================

export async function DELETE(request: Request) {
  // Validate internal secret
  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sandboxId } = await request.json();

    if (!sandboxId) {
      return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
    }

    // Check if OIDC token is available (required for Vercel SDK)
    if (!process.env.VERCEL_OIDC_TOKEN) {
      console.warn(`[Internal] VERCEL_OIDC_TOKEN not set, cannot stop ${sandboxId} via SDK`);
      // Return success anyway - sandbox will auto-expire, and Convex state is already updated
      return NextResponse.json({
        success: true,
        sandboxId,
        warning: "OIDC token not available - sandbox will auto-expire"
      });
    }

    try {
      const sandbox = await Sandbox.get({ sandboxId });

      // Check if already stopped
      if (sandbox.status === "stopped" || sandbox.status === "stopping") {
        console.log(`[Internal] Sandbox ${sandboxId} already stopped/stopping`);
        return NextResponse.json({ success: true, sandboxId, alreadyStopped: true });
      }

      await sandbox.stop();
      console.log(`[Session ended] Sandbox stopped: ${sandboxId}`);
    } catch (sandboxError) {
      const errorMessage = sandboxError instanceof Error ? sandboxError.message : String(sandboxError);
      console.error(`[Internal] Sandbox.get/stop error for ${sandboxId}:`, errorMessage);

      // Handle various error cases gracefully
      const isNotFound =
        errorMessage.includes("not found") ||
        errorMessage.includes("does not exist") ||
        errorMessage.includes("404");

      const isAuthError =
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("401") ||
        errorMessage.includes("403") ||
        errorMessage.includes("OIDC") ||
        errorMessage.includes("token");

      if (isNotFound) {
        console.log(`[Internal] Sandbox ${sandboxId} not found (may already be stopped)`);
        return NextResponse.json({ success: true, sandboxId, notFound: true });
      }

      if (isAuthError) {
        // Auth error - sandbox may still exist but we can't stop it
        // Return success to let Convex clean up its state, sandbox will auto-expire
        console.warn(`[Internal] Auth error stopping ${sandboxId}, will auto-expire`);
        return NextResponse.json({
          success: true,
          sandboxId,
          warning: "Auth error - sandbox will auto-expire"
        });
      }

      throw sandboxError;
    }

    return NextResponse.json({ success: true, sandboxId });
  } catch (error) {
    console.error("Failed to stop sandbox:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// =============================================================================
// PATCH Handler - Extend Timeout (Internal use by Convex)
// =============================================================================

export async function PATCH(request: Request) {
  // Validate internal secret
  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sandboxId, action, duration } = await request.json();

    if (!sandboxId) {
      return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
    }

    // Check if OIDC token is available (required for Vercel SDK)
    if (!process.env.VERCEL_OIDC_TOKEN) {
      console.warn(`[Internal] VERCEL_OIDC_TOKEN not set for PATCH ${sandboxId}`);
      return NextResponse.json(
        { error: "OIDC token not available" },
        { status: 503 }
      );
    }

    if (action === "extend") {
      if (!duration || typeof duration !== "number") {
        return NextResponse.json({ error: "Missing or invalid duration" }, { status: 400 });
      }

      try {
        const sandbox = await Sandbox.get({ sandboxId });

        // Check if sandbox is still running
        if (sandbox.status !== "running") {
          return NextResponse.json(
            { error: `Sandbox is ${sandbox.status}, cannot extend` },
            { status: 400 }
          );
        }

        // Extend the timeout
        await sandbox.extendTimeout(duration);
        console.log(`[Internal] Sandbox ${sandboxId} extended by ${duration}ms`);

        return NextResponse.json({
          success: true,
          sandboxId,
          newTimeout: sandbox.timeout,
        });
      } catch (sandboxError) {
        const errorMessage = sandboxError instanceof Error ? sandboxError.message : "";
        if (
          errorMessage.includes("not found") ||
          errorMessage.includes("does not exist")
        ) {
          return NextResponse.json(
            { error: "Sandbox not found" },
            { status: 404 }
          );
        }
        throw sandboxError;
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Failed to patch sandbox:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
