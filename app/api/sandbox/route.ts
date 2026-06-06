import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import { CreateSandboxRequest } from "../../data/skills";
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
  // triggerSnapshotRenewal, // disabled: low traffic, renewal bursts waste Vercel resources
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

  // Validation - return plain JSON errors (no need to stream these)
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let sandbox: Sandbox | null = null;
      let success = false;

      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        const provider = CLI_PROVIDERS[cliProvider];

        // 1. Resolve playground and snapshot from Convex only (prefer compatible prebaked for OpenCode)
        send({ step: "Resolving snapshot" });
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
        send({ step: "Resolving snapshot", status: "done" });

        // 2. Create Sandbox (shared helper with snapshot fallback)
        const createLabel = snapshotId ? "Restoring from snapshot" : "Creating sandbox";
        send({ step: createLabel });
        console.log(
          snapshotId
            ? `Creating sandbox from snapshot (${playground?.id}), skill ${skillName}, using ${provider.name}...`
            : `Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}, using ${provider.name}...`
        );
        const { sandbox: createdSandbox, snapshotUsed } =
          await createSandboxWithSnapshotOrGit({
            targetOwner,
            targetRepo,
            snapshotId,
          });
        sandbox = createdSandbox;

        // Snapshot renewal disabled: low traffic, renewal bursts waste Vercel resources
        // if (playground && (!snapshotId || !snapshotUsed)) {
        //   const renewalPromise = triggerSnapshotRenewal(playground.id, playground.owner, playground.repo).catch(
        //     (err) => console.warn("[Sandbox] Renewal trigger failed:", err)
        //   );
        //   after(renewalPromise);
        // }
        send({ step: createLabel, status: "done" });

        const skipOpencodeInstall =
          cliProvider === "opencode" && usedCompatibleOpencodeSnapshot && snapshotUsed;

        // 3. Install CLI (skip when prebaked OpenCode snapshot was used)
        if (!skipOpencodeInstall) {
          send({ step: `Installing ${provider.name}` });
          await installCLI(sandbox, provider);
          send({ step: `Installing ${provider.name}`, status: "done" });
        } else {
          console.log("Skipping OpenCode CLI install (prebaked snapshot)");
        }

        // 4. Install TTYD
        send({ step: "Setting up terminal" });
        const ttydPath = await installTTYD(sandbox);
        send({ step: "Setting up terminal", status: "done" });

        // 5. Inject the Skill
        send({ step: `Injecting skill: ${skillName}` });
        await injectSkill(sandbox, skillOwner, skillRepo, skillName);
        send({ step: `Injecting skill: ${skillName}`, status: "done" });

        // 6. Configure CLI (skip when prebaked OpenCode snapshot was used)
        if (!skipOpencodeInstall) {
          send({ step: "Configuring environment" });
          console.log(`Setting up ${provider.name} CLI configuration...`);
          await provider.configSetup(sandbox);
          send({ step: "Configuring environment", status: "done" });
        } else {
          console.log("Skipping OpenCode config (prebaked snapshot)");
        }

        // 7. Launch TTYD with CLI
        send({ step: "Launching terminal" });
        await launchTTYD(sandbox, ttydPath, provider, anthropicApiKey);
        send({ step: "Launching terminal", status: "done" });

        // 8. Start dev server (detects project type: Node, Python, Go, Java)
        send({ step: "Starting dev server" });
        const devPort = await startDevServer(sandbox);
        const warmUpPromise = warmSandboxServicesInBackground(sandbox, devPort, {
          sandboxId: sandbox.sandboxId,
        });
        after(warmUpPromise);
        send({ step: "Starting dev server", status: "done" });

        const ttydUrl = sandbox.domain(7681);
        // Expose preview URL immediately; readiness probes run in background.
        const previewUrl = sandbox.domain(devPort);
        console.log(`Sandbox ready: ${ttydUrl}${previewUrl ? `, preview: ${previewUrl}` : ""}`);

        success = true;
        send({
          done: true,
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
        send({
          error: error instanceof Error ? error.message : "Failed to initialize",
        });
      } finally {
        if (sandbox != null && !success) {
          try {
            await sandbox.stop();
            console.log(`Stopped failed sandbox: ${sandbox.sandboxId}`);
          } catch (stopErr) {
            console.error("Failed to stop sandbox:", stopErr);
          }
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
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
      console.log(`[Session ended] Sandbox stopped: ${sandboxId}`);
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
