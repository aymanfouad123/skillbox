import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import ms from "ms";
import { CreateSandboxRequest } from "../../data/skills";
import {
  CLI_PROVIDERS,
  installCLI,
  installTTYD,
  injectSkill,
  launchTTYD,
  waitForTTYD,
  createFreshNextJS,
} from "../../lib/sandbox-utils";

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
    // _create = sentinel from queue/claim flow; create/nextjs = "New Next.js" playground
    const isCreateNew =
      targetOwner === "_create" ||
      (targetOwner === "create" && targetRepo === "nextjs");

    console.log(
      isCreateNew
        ? `Creating sandbox with fresh ${targetRepo} project, skill ${skillName}, using ${provider.name}...`
        : `Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}, using ${provider.name}...`
    );

    // 1. Create Sandbox with Vercel Sandbox SDK
    // Note: Backend timeout includes setup time (~60-90s for Next.js creation).
    // Frontend shows 6 minutes, but we give 7 minutes on backend to account for
    // setup overhead, ensuring users get the full 6 minutes of actual usage.
    if (isCreateNew && targetRepo === "nextjs") {
      // For fresh Next.js, create empty sandbox and run create-next-app
      // Extra time needed for create-next-app (~90s setup)
      sandbox = await Sandbox.create({
        resources: { vcpus: 2 },
        timeout: ms("7m"),
        ports: [7681],
        runtime: "node22",
      });

      console.log(`Sandbox created: ${sandbox.sandboxId}`);
      await createFreshNextJS(sandbox);
    } else {
      // Clone existing repo for other playgrounds (~60s setup)
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${targetOwner}/${targetRepo}.git`,
          depth: 1,
        },
        resources: { vcpus: 2 },
        timeout: ms("7m"), // Aligned with Next.js creation for consistency
        ports: [7681],
        runtime: "node22",
      });

      console.log(`Sandbox created: ${sandbox.sandboxId}`);
    }

    // 2. Install CLI for selected provider
    await installCLI(sandbox, provider);

    // 3. Install TTYD
    const ttydPath = await installTTYD(sandbox);

    // 4. Inject the Skill
    await injectSkill(sandbox, skillOwner, skillRepo, skillName);

    // 5. Configure CLI
    console.log(`Setting up ${provider.name} CLI configuration...`);
    await provider.configSetup(sandbox);

    // 6. Launch TTYD with CLI
    await launchTTYD(sandbox, ttydPath, provider, anthropicApiKey);

    // 7. Wait for TTYD to be ready
    const ready = await waitForTTYD(sandbox);
    if (!ready) console.warn("TTYD timed out but returning URL anyway.");

    // Give TTYD and CLI additional time to fully initialize
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const ttydUrl = sandbox.domain(7681);
    console.log(`Sandbox ready: ${ttydUrl}`);

    success = true;
    return NextResponse.json({
      sandboxId: sandbox.sandboxId,
      ttydUrl,
      status: "ready",
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

    // Connect to existing sandbox and stop it
    const sandbox = await Sandbox.get({ sandboxId });
    await sandbox.stop();

    console.log(`Sandbox stopped: ${sandboxId}`);

    return NextResponse.json({ success: true, sandboxId });
  } catch (error) {
    console.error("Failed to stop sandbox:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
