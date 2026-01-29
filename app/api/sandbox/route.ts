import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import ms from "ms";
import { CLIProvider, CreateSandboxRequest } from "../../data/skills";

// =============================================================================
// CLI Provider Configuration
// =============================================================================

interface CLIProviderConfig {
  name: string;
  installCommand: { cmd: string; args: string[] };
  configSetup: (sandbox: Sandbox) => Promise<void>;
  getLaunchCommand: (apiKey?: string) => string;
}

const CLI_PROVIDERS: Record<CLIProvider, CLIProviderConfig> = {
  opencode: {
    name: "OpenCode",
    installCommand: {
      cmd: "npm",
      args: ["install", "-g", "opencode-ai"],
    },
    configSetup: async (sandbox: Sandbox) => {
      // Create opencode config directory and files for headless operation
      // Global config at ~/.config/opencode/opencode.json
      const globalConfig = JSON.stringify({
        model: "opencode/gpt-5-nano",
        autoupdate: false,
      });
      // Project config at /vercel/sandbox/opencode.json
      const projectConfig = JSON.stringify({
        model: "opencode/gpt-5-nano",
      });
      await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-c",
          `mkdir -p ~/.config/opencode && ` +
            `echo '${globalConfig}' > ~/.config/opencode/opencode.json && ` +
            `echo '${projectConfig}' > /vercel/sandbox/opencode.json`,
        ],
      });
    },
    getLaunchCommand: () =>
      `FORCE_COLOR=1 ` +
      `TERM=xterm-256color ` +
      `COLORTERM=truecolor ` +
      `EDITOR=cat ` +
      `VISUAL=cat && ` +
      `exec opencode`,
  },
  claude: {
    name: "Claude",
    installCommand: {
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
    },
    configSetup: async (sandbox: Sandbox) => {
      // Pre-configure Claude CLI to skip onboarding
      const configPayload = JSON.stringify({
        hasCompletedOnboarding: true,
        autoUpdaterStatus: "disabled",
      });
      await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-c",
          `mkdir -p /home/vercel-sandbox/.claude && ` +
            `echo '${configPayload}' > /home/vercel-sandbox/.claude.json`,
        ],
      });
    },
    getLaunchCommand: (apiKey?: string) =>
      `export ANTHROPIC_API_KEY='${apiKey}' ` +
      `FORCE_COLOR=1 ` +
      `TERM=xterm-256color ` +
      `COLORTERM=truecolor ` +
      `EDITOR=cat ` +
      `VISUAL=cat && ` +
      `exec claude`,
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Install the CLI tool for the selected provider
 */
async function installCLI(
  sandbox: Sandbox,
  provider: CLIProviderConfig,
): Promise<void> {
  console.log(`Installing ${provider.name} CLI...`);
  const result = await sandbox.runCommand({
    cmd: provider.installCommand.cmd,
    args: provider.installCommand.args,
  });

  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    console.warn(`${provider.name} CLI install warning: ${stderr}`);
  }
}

/**
 * Install TTYD web terminal
 */
async function installTTYD(sandbox: Sandbox): Promise<string> {
  console.log("Installing TTYD...");
  const ttydInstall = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-c",
      `curl -sL -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && ` +
        `chmod +x /tmp/ttyd && ` +
        `mv /tmp/ttyd /usr/local/bin/ttyd || mv /tmp/ttyd /vercel/sandbox/ttyd`,
    ],
    sudo: true,
  });

  const ttydPath = ttydInstall.exitCode === 0 ? "ttyd" : "/vercel/sandbox/ttyd";
  console.log(`TTYD installed at: ${ttydPath}`);
  return ttydPath;
}

/**
 * Inject the skill into the sandbox
 */
async function injectSkill(
  sandbox: Sandbox,
  skillOwner: string,
  skillRepo: string,
  skillName: string,
): Promise<void> {
  console.log(`Adding skill: ${skillName}...`);
  const skillResult = await sandbox.runCommand({
    cmd: "npx",
    args: [
      "-y",
      "skills",
      "add",
      `${skillOwner}/${skillRepo}`,
      "--skill",
      skillName,
      "--yes",
    ],
    cwd: "/vercel/sandbox",
  });

  if (skillResult.exitCode !== 0) {
    const stderr = await skillResult.stderr();
    console.warn(`Skill add warning (continuing): ${stderr}`);
  }
  console.log("Skill injection completed");
}

/**
 * Launch TTYD with the CLI in detached mode
 */
async function launchTTYD(
  sandbox: Sandbox,
  ttydPath: string,
  provider: CLIProviderConfig,
  apiKey?: string,
): Promise<void> {
  console.log(`Launching ${provider.name} Agent...`);
  await sandbox.runCommand({
    cmd: "bash",
    args: [
      "--norc",
      "--noprofile",
      "-c",
      `cd /vercel/sandbox && ` +
        `${ttydPath} -p 7681 -W -i 0.0.0.0 ` +
        `--ping-interval 5 ` +
        `--client-option reconnect=3 ` +
        `--client-option autoReconnect=true ` +
        `-t fontSize=14 ` +
        `-t 'theme={"background":"#0a0a0a"}' ` +
        `bash --norc --noprofile -c "` +
        provider.getLaunchCommand(apiKey) +
        `"`,
    ],
    detached: true,
  });
}

/**
 * Wait for TTYD to be ready
 */
async function waitForTTYD(sandbox: Sandbox): Promise<boolean> {
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const check = await sandbox.runCommand({
        cmd: "curl",
        args: ["-s", "http://localhost:7681"],
      });
      if (check.exitCode === 0) {
        ready = true;
        break;
      }
    } catch {
      // Port not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return ready;
}

/**
 * Create a fresh Next.js project in the sandbox
 */
async function createFreshNextJS(sandbox: Sandbox): Promise<void> {
  console.log("Setting up fresh Next.js project...");

  // create-next-app has a strict permission check that fails on /vercel/sandbox
  // Workaround: create in /tmp first (always writable), then copy to /vercel/sandbox
  console.log("Running create-next-app in /tmp...");
  const createResult = await sandbox.runCommand({
    cmd: "npx",
    args: [
      "-y",
      "create-next-app@latest",
      "/tmp/nextjs-project",
      "--typescript",
      "--tailwind",
      "--eslint",
      "--app",
      "--no-git",
      "--no-src-dir",
      "--import-alias",
      "@/*",
      "--use-pnpm",
      "--yes",
    ],
  });

  const createStdout = await createResult.stdout();
  const createStderr = await createResult.stderr();
  console.log(`create-next-app exit code: ${createResult.exitCode}`);
  if (createResult.exitCode !== 0) {
    console.log(`create-next-app stdout: ${createStdout}`);
    console.log(`create-next-app stderr: ${createStderr}`);
  }

  // Copy everything from /tmp/nextjs-project to /vercel/sandbox
  console.log("Copying project to /vercel/sandbox...");
  const copyResult = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-c",
      "cp -r /tmp/nextjs-project/* /vercel/sandbox/ && cp -r /tmp/nextjs-project/.[!.]* /vercel/sandbox/ 2>/dev/null || true && rm -rf /tmp/nextjs-project",
    ],
  });
  if (copyResult.exitCode !== 0) {
    const copyStderr = await copyResult.stderr();
    console.log(`Copy warning: ${copyStderr}`);
  }

  // Verify setup
  const verifyResult = await sandbox.runCommand({
    cmd: "ls",
    args: ["-la"],
    cwd: "/vercel/sandbox",
  });
  const verifyStdout = await verifyResult.stdout();
  console.log(`Directory contents: ${verifyStdout}`);

  console.log("Fresh Next.js project ready");
}

// =============================================================================
// POST Handler - Create Sandbox
// =============================================================================

export async function POST(request: Request) {
  let sandbox: Sandbox | null = null;

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
        { status: 400 },
      );
    }

    if (cliProvider === "claude" && !anthropicApiKey) {
      return NextResponse.json(
        { error: "Anthropic API key is required for Claude CLI" },
        { status: 400 },
      );
    }

    const provider = CLI_PROVIDERS[cliProvider];
    const isCreateNew = targetOwner === "_create";

    console.log(
      isCreateNew
        ? `Creating sandbox with fresh ${targetRepo} project, skill ${skillName}, using ${provider.name}...`
        : `Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}, using ${provider.name}...`,
    );

    // 1. Create Sandbox with Vercel Sandbox SDK
    // Note: Sandbox timeout includes setup time (~60-90s), so we add buffer
    // to ensure the frontend's 5-minute session timer stays in sync
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
        timeout: ms("6m"),
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

    return NextResponse.json({
      sandboxId: sandbox.sandboxId,
      ttydUrl,
      status: "ready",
    });
  } catch (error) {
    console.error("Sandbox creation failed:", error);
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
      { status: 500 },
    );
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
      { status: 500 },
    );
  }
}
