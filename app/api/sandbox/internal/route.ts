import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import ms from "ms";
import { CLIProvider } from "../../../data/skills";
import {
  CLI_PROVIDERS,
  installCLI,
  installTTYD,
  injectSkill,
  launchTTYD,
  waitForTTYD,
  createFreshNextJS,
} from "../../../lib/sandbox-utils";

// =============================================================================
// Internal Secret Validation
// =============================================================================

function validateInternalSecret(request: Request): boolean {
  const secret = request.headers.get("X-Internal-Secret");
  const expectedSecret = process.env.CONVEX_INTERNAL_SECRET;

  // In development, allow if no secret is set
  if (!expectedSecret && process.env.NODE_ENV === "development") {
    return true;
  }

  return secret === expectedSecret;
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
    const isCreateNew = targetOwner === "_create";

    console.log(
      isCreateNew
        ? `[Internal] Creating sandbox with fresh ${targetRepo} project, skill ${skillName}, using ${provider.name}...`
        : `[Internal] Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}, using ${provider.name}...`
    );

    // 1. Create Sandbox
    // Backend timeout is 7 minutes to account for setup overhead.
    // Frontend shows 6 minutes - the extra minute is buffer for setup.
    if (isCreateNew && targetRepo === "nextjs") {
      sandbox = await Sandbox.create({
        resources: { vcpus: 2 },
        timeout: ms("7m"),
        ports: [7681],
        runtime: "node22",
      });

      console.log(`Sandbox created: ${sandbox.sandboxId}`);
      await createFreshNextJS(sandbox);
    } else {
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${targetOwner}/${targetRepo}.git`,
          depth: 1,
        },
        resources: { vcpus: 2 },
        timeout: ms("7m"), // Aligned for consistency
        ports: [7681],
        runtime: "node22",
      });

      console.log(`Sandbox created: ${sandbox.sandboxId}`);
    }

    // 2. Install CLI
    await installCLI(sandbox, provider);

    // 3. Install TTYD
    const ttydPath = await installTTYD(sandbox);

    // 4. Inject the Skill
    await injectSkill(sandbox, skillOwner, skillRepo, skillName);

    // 5. Configure CLI
    console.log(`Setting up ${provider.name} CLI configuration...`);
    await provider.configSetup(sandbox);

    // 6. Launch TTYD
    await launchTTYD(sandbox, ttydPath, provider, anthropicApiKey);

    // 7. Wait for TTYD
    const ready = await waitForTTYD(sandbox);
    if (!ready) console.warn("TTYD timed out but returning URL anyway.");

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const ttydUrl = sandbox.domain(7681);
    console.log(`Sandbox ready: ${ttydUrl}`);

    return NextResponse.json({
      sandboxId: sandbox.sandboxId,
      ttydUrl,
      status: "ready",
    });
  } catch (error) {
    console.error("Internal sandbox creation failed:", error);
    if (sandbox) {
      try {
        await sandbox.stop();
        console.log(`Stopped failed sandbox: ${sandbox.sandboxId}`);
      } catch (stopErr) {
        console.error("Failed to stop sandbox:", stopErr);
      }
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to initialize",
      },
      { status: 500 }
    );
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

    const sandbox = await Sandbox.get({ sandboxId });
    await sandbox.stop();

    console.log(`[Internal] Sandbox stopped: ${sandboxId}`);

    return NextResponse.json({ success: true, sandboxId });
  } catch (error) {
    console.error("Failed to stop sandbox:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
