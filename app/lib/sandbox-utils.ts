import { Sandbox } from "@vercel/sandbox";
import { CLIProvider } from "../data/skills";

// =============================================================================
// CLI Provider Configuration
// =============================================================================

export interface CLIProviderConfig {
  name: string;
  installCommand: { cmd: string; args: string[] };
  configSetup: (sandbox: Sandbox) => Promise<void>;
  getLaunchCommand: (apiKey?: string) => string;
}

export const CLI_PROVIDERS: Record<CLIProvider, CLIProviderConfig> = {
  opencode: {
    name: "OpenCode",
    installCommand: {
      cmd: "npm",
      args: ["install", "-g", "opencode-ai"],
    },
    configSetup: async (sandbox: Sandbox) => {
      // Create opencode config directory and files for headless operation
      const globalConfig = JSON.stringify({
        model: "opencode/gpt-5-nano",
        autoupdate: false,
      });
      const projectConfig = JSON.stringify({
        model: "opencode/gpt-5-nano",
      });
      await sandbox.mkDir("/home/vercel-sandbox/.config/opencode");
      await sandbox.writeFiles([
        {
          path: "/home/vercel-sandbox/.config/opencode/opencode.json",
          content: Buffer.from(globalConfig, "utf8"),
        },
        {
          path: "/vercel/sandbox/opencode.json",
          content: Buffer.from(projectConfig, "utf8"),
        },
      ]);
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
      await sandbox.writeFiles([
        {
          path: "/home/vercel-sandbox/.claude.json",
          content: Buffer.from(configPayload, "utf8"),
        },
      ]);
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
// Sandbox Setup Helpers
// =============================================================================

/**
 * Install the CLI tool for the selected provider
 */
export async function installCLI(
  sandbox: Sandbox,
  provider: CLIProviderConfig
): Promise<void> {
  console.log(`Installing ${provider.name} CLI...`);
  const result = await sandbox.runCommand({
    cmd: provider.installCommand.cmd,
    args: provider.installCommand.args,
    stderr: process.stderr,
    stdout: process.stdout,
    sudo: true,
  });

  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(
      `${provider.name} CLI install failed: exitCode ${result.exitCode}, stderr: ${stderr}`
    );
  }
}

/**
 * Install TTYD web terminal
 */
export async function installTTYD(sandbox: Sandbox): Promise<string> {
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
export async function injectSkill(
  sandbox: Sandbox,
  skillOwner: string,
  skillRepo: string,
  skillName: string
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
export async function launchTTYD(
  sandbox: Sandbox,
  ttydPath: string,
  provider: CLIProviderConfig,
  apiKey?: string
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
export async function waitForTTYD(sandbox: Sandbox): Promise<boolean> {
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
export async function createFreshNextJS(sandbox: Sandbox): Promise<void> {
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
