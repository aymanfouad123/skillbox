import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import { CreateSandboxRequest } from "../../data/skills";
import {
  CLI_PROVIDERS,
  installCLI,
  installTTYD,
  injectSkill,
  launchTTYD,
  waitForTTYD,
  waitForDevServer,
  startDevServer,
  createSandboxWithSnapshotOrGit,
  resolvePlayground,
  OPENCODE_SNAPSHOT_SETUP_VERSION,
  triggerSnapshotRenewal,
} from "../../lib/sandbox-utils";

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
// POST Handler - Create Sandbox
// =============================================================================

export async function POST(request: Request) {
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
      cliProvider = "opencode", // Default to opencode for backwards compatibility
      anthropicApiKey,
    } = body;

    // Validation - API key only required for Claude
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
            console.log(`Using compatible OpenCode snapshot: ${snapshotId}`);
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
            console.log(`Using Convex snapshot: ${snapshotId}`);
          }
        }
      } catch (err) {
        console.log("Convex snapshot query failed, using fallback:", err);
      }
    }

    console.log(
      snapshotId
        ? `Creating sandbox from snapshot (${playground?.id}), skill ${skillName}, using ${provider.name}...`
        : `Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}, using ${provider.name}...`
    );

    // 2. Create Sandbox (shared helper with snapshot fallback)
    const { sandbox: createdSandbox, snapshotUsed } =
      await createSandboxWithSnapshotOrGit({
        targetOwner,
        targetRepo,
        snapshotId,
      });
    sandbox = createdSandbox;

    if (snapshotId && !snapshotUsed && playground) {
      // Fire-and-forget: don't block sandbox boot on renewal
      triggerSnapshotRenewal(playground.id, playground.owner, playground.repo).catch(
        (err) => console.warn("[Sandbox] Renewal trigger failed:", err)
      );
    }

    const skipOpencodeInstall =
      cliProvider === "opencode" && usedCompatibleOpencodeSnapshot && snapshotUsed;

    // 3. Install CLI (skip when prebaked OpenCode snapshot was used)
    if (!skipOpencodeInstall) {
      await installCLI(sandbox, provider);
    } else {
      console.log("Skipping OpenCode CLI install (prebaked snapshot)");
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
      console.log("Skipping OpenCode config (prebaked snapshot)");
    }

    // 7. Launch TTYD with CLI
    await launchTTYD(sandbox, ttydPath, provider, anthropicApiKey);

    // 8. Start dev server (detects project type: Node, Python, Go, Java) and wait for readiness
    const devPort = await startDevServer(sandbox);
    const devReady = await waitForDevServer(sandbox, devPort);
    if (!devReady) console.warn("Dev server timed out but continuing anyway.");

    // 9. Wait for TTYD to be ready
    const ready = await waitForTTYD(sandbox);
    if (!ready) console.warn("TTYD timed out but returning URL anyway.");

    // Give TTYD and CLI additional time to fully initialize
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const ttydUrl = sandbox.domain(7681);
    // Expose preview URL even when readiness probe times out; app may still become ready shortly after.
    const previewUrl = sandbox.domain(devPort);
    console.log(`Sandbox ready: ${ttydUrl}${previewUrl ? `, preview: ${previewUrl}` : ""}`);

    success = true;
    return NextResponse.json({
      sandboxId: sandbox.sandboxId,
      ttydUrl,
      previewUrl,
      status: "ready",
      // Vercel timing for accurate frontend countdown
      vercelCreatedAt: sandbox.createdAt.getTime(),
      vercelTimeout: sandbox.timeout,
    });
  } catch (error) {
    console.error("Sandbox creation failed:", error);
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
// DELETE Handler - Stop Sandbox
// =============================================================================

export async function DELETE(request: Request) {
  try {
    const { sandboxId } = await request.json();

    if (!sandboxId) {
      return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
    }

    // Check if OIDC token is available (required for Vercel SDK)
    if (!process.env.VERCEL_OIDC_TOKEN) {
      console.warn(`VERCEL_OIDC_TOKEN not set, cannot stop ${sandboxId} via SDK`);
      // Return success anyway - sandbox will auto-expire
      return NextResponse.json({
        success: true,
        sandboxId,
        warning: "OIDC token not available - sandbox will auto-expire"
      });
    }

    try {
      // Connect to existing sandbox and stop it
      const sandbox = await Sandbox.get({ sandboxId });

      // Check if already stopped
      if (sandbox.status === "stopped" || sandbox.status === "stopping") {
        console.log(`Sandbox ${sandboxId} already stopped/stopping`);
        return NextResponse.json({ success: true, sandboxId, alreadyStopped: true });
      }

      await sandbox.stop();
      console.log(`Sandbox stopped: ${sandboxId}`);
    } catch (sandboxError) {
      const errorMessage = sandboxError instanceof Error ? sandboxError.message : String(sandboxError);
      console.error(`Sandbox.get/stop error for ${sandboxId}:`, errorMessage);

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
        console.log(`Sandbox ${sandboxId} not found (may already be stopped)`);
        return NextResponse.json({ success: true, sandboxId, notFound: true });
      }

      if (isAuthError) {
        // Auth error - sandbox may still exist but we can't stop it
        // Return success to let Convex clean up its state, sandbox will auto-expire
        console.warn(`Auth error stopping ${sandboxId}, will auto-expire`);
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
