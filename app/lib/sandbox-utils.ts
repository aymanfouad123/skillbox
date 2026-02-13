import { Sandbox } from "@vercel/sandbox";
import ms from "ms";
import { CLIProvider, PLAYGROUNDS } from "../data/skills";

// Re-export from convex for use in routes
export { OPENCODE_SNAPSHOT_SETUP_VERSION } from "../../convex/constants";

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
  provider: CLIProviderConfig,
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
      `${provider.name} CLI install failed: exitCode ${result.exitCode}, stderr: ${stderr}`,
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
export async function launchTTYD(
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

// =============================================================================
// Project type detection and multi-runtime dev server
// =============================================================================

export type ProjectType = "node" | "python" | "go" | "java" | "unknown";

export interface DevServerConfig {
  port: number;
  /** Shell command to run in /vercel/sandbox (e.g. "npm run dev") */
  command: string;
  label: string;
}

/**
 * Detect project type from repo contents so we can start the right dev server
 * and use sandbox.domain(port) for preview.
 */
export async function detectProjectType(
  sandbox: Sandbox,
): Promise<ProjectType> {
  const checks = [
    { path: "/vercel/sandbox/package.json", type: "node" as const },
    { path: "/vercel/sandbox/requirements.txt", type: "python" as const },
    { path: "/vercel/sandbox/pyproject.toml", type: "python" as const },
    { path: "/vercel/sandbox/go.mod", type: "go" as const },
    { path: "/vercel/sandbox/pom.xml", type: "java" as const },
  ];
  for (const { path, type } of checks) {
    const f = await sandbox.readFileToBuffer({ path });
    if (f != null) return type;
  }
  return "unknown";
}

/**
 * Get dev server command and preview port for a project type.
 * We standardize previews on port 3000 to keep exposed sandbox ports minimal.
 */
export function getDevServerConfig(
  sandbox: Sandbox,
  projectType: ProjectType,
): Promise<DevServerConfig> {
  switch (projectType) {
    case "node": {
      return (async () => {
        const pnpmLock = await sandbox.readFileToBuffer({
          path: "/vercel/sandbox/pnpm-lock.yaml",
        });
        if (pnpmLock != null) {
          return {
            port: 3000,
            command: "pnpm install --frozen-lockfile && pnpm run dev",
            label: "Node (pnpm)",
          };
        }
        const yarnLock = await sandbox.readFileToBuffer({
          path: "/vercel/sandbox/yarn.lock",
        });
        if (yarnLock != null) {
          return {
            port: 3000,
            command: "yarn install --frozen-lockfile && yarn dev",
            label: "Node (yarn)",
          };
        }
        return {
          port: 3000,
          command: "npm install --no-audit --no-fund && npm run dev",
          label: "Node (npm)",
        };
      })();
    }
    case "python": {
      return (async () => {
        const reqFile = await sandbox.readFileToBuffer({
          path: "/vercel/sandbox/requirements.txt",
        });
        const reqContent = reqFile?.toString() ?? "";
        if (/flask/i.test(reqContent)) {
          return {
            port: 3000,
            command:
              "pip install -q -r requirements.txt && flask run --host=0.0.0.0 --port 3000",
            label: "Flask",
          };
        }
        if (reqContent.includes("uvicorn")) {
          return {
            port: 3000,
            command:
              "pip install -q -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 3000",
            label: "FastAPI",
          };
        }
        return {
          port: 3000,
          command: "python3 -m http.server 3000",
          label: "Python",
        };
      })();
    }
    case "go":
      return Promise.resolve({
        port: 3000,
        command: "PORT=3000 go run . 2>/dev/null || PORT=3000 go run main.go",
        label: "Go",
      });
    case "java":
      return Promise.resolve({
        port: 3000,
        command:
          "mvn -q spring-boot:run -Dspring-boot.run.arguments=--server.port=3000",
        label: "Java",
      });
    default:
      return Promise.resolve({
        port: 3000,
        command: "npm run dev 2>/dev/null || true",
        label: "Unknown",
      });
  }
}

/**
 * Start the dev server based on detected project type.
 * Returns the port used so the caller can call sandbox.domain(port) for preview.
 */
export async function startDevServer(sandbox: Sandbox): Promise<number> {
  const projectType = await detectProjectType(sandbox);
  const config = await getDevServerConfig(sandbox, projectType);
  console.log(`Starting dev server (${config.label}, port ${config.port})...`);
  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", `cd /vercel/sandbox && ${config.command}`],
    cwd: "/vercel/sandbox",
    detached: true,
  });
  console.log(`Dev server started: ${config.command}`);
  return config.port;
}

/**
 * Wait for dev server on the given port to be ready.
 */
export async function waitForDevServer(
  sandbox: Sandbox,
  port: number,
): Promise<boolean> {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const check = await sandbox.runCommand({
        cmd: "curl",
        args: [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `http://localhost:${port}`,
        ],
      });
      const code = await check.stdout();
      if (check.exitCode === 0 && code !== "000") {
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

export interface WarmSandboxOptions {
  /** Prefix for log messages */
  logPrefix?: string;
  /** When set and dev server becomes ready, mark preview ready in Convex via HTTP action */
  sandboxId?: string;
}

/**
 * Run readiness probes without blocking API response.
 * When dev server is ready and sandboxId is set, calls Convex HTTP action to set previewReady.
 * Requires NEXT_PUBLIC_CONVEX_SITE_URL (HTTP actions base URL) and CONVEX_INTERNAL_SECRET to be set.
 */
export function warmSandboxServicesInBackground(
  sandbox: Sandbox,
  devPort: number,
  options: WarmSandboxOptions = {},
): void {
  const logPrefix = options.logPrefix ?? "";
  const sandboxId = options.sandboxId;
  const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  const secret = process.env.CONVEX_INTERNAL_SECRET;

  void (async () => {
    const [devReady, ttydReady] = await Promise.all([
      waitForDevServer(sandbox, devPort),
      waitForTTYD(sandbox),
    ]);
    if (!devReady) {
      console.warn(`${logPrefix}Dev server timed out but continuing anyway.`);
    }
    if (!ttydReady) {
      console.warn(`${logPrefix}TTYD timed out but returning URL anyway.`);
    }
    if (devReady && ttydReady) {
      console.log(`${logPrefix}TTYD and preview are ready.`);
    }
    if (devReady && sandboxId && !siteUrl) {
      console.warn(
        `${logPrefix}NEXT_PUBLIC_CONVEX_SITE_URL not set, skipping mark-preview-ready.`,
      );
    }
    if (devReady && sandboxId && siteUrl && secret) {
      try {
        const res = await fetch(`${siteUrl}/mark-preview-ready`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": secret,
          },
          body: JSON.stringify({ sandboxId }),
        });
        if (!res.ok) {
          console.warn(
            `${logPrefix}Failed to mark preview ready: ${res.status}`,
          );
        }
      } catch (err) {
        console.warn(`${logPrefix}Mark preview ready request failed:`, err);
      }
    }
  })().catch((err) => {
    console.warn(`${logPrefix}Background warm-up failed:`, err);
  });
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

// =============================================================================
// Shared Sandbox Creation
// =============================================================================

export interface CreateSandboxParams {
  targetOwner: string;
  targetRepo: string;
  snapshotId: string | null;
  logPrefix?: string;
}

export interface CreateSandboxResult {
  sandbox: Sandbox;
  /** True if the sandbox was created from a snapshot (not git/create-next-app) */
  snapshotUsed: boolean;
}

/**
 * Create sandbox from snapshot (with fallback) or git/create-next-app.
 * Shared by public and internal sandbox routes.
 * Returns outcome so callers can skip OpenCode install when prebaked and trigger renewal on failure.
 */
export async function createSandboxWithSnapshotOrGit(
  params: CreateSandboxParams,
): Promise<CreateSandboxResult> {
  const { targetOwner, targetRepo, snapshotId, logPrefix = "" } = params;
  let sandbox: Sandbox | null = null;
  let snapshotUsed = false;

  if (snapshotId) {
    try {
      sandbox = await Sandbox.create({
        source: { type: "snapshot", snapshotId },
        resources: { vcpus: 2 },
        timeout: ms("7m"),
        ports: [3000, 7681],
        runtime: "node24",
      });
      snapshotUsed = true;
      console.log(
        `${logPrefix}Sandbox created from snapshot: ${sandbox.sandboxId}`,
      );
    } catch (snapshotErr) {
      console.warn(
        `${logPrefix}Snapshot boot failed (${snapshotId}), falling back to git/create-next-app:`,
        snapshotErr instanceof Error ? snapshotErr.message : snapshotErr,
      );
    }
  }

  if (!sandbox) {
    const isCreateNew =
      targetOwner === "_create" ||
      targetOwner === "fresh" ||
      (targetOwner === "create" && targetRepo === "nextjs");

    if (isCreateNew && targetRepo === "nextjs") {
      sandbox = await Sandbox.create({
        resources: { vcpus: 2 },
        timeout: ms("7m"),
        ports: [3000, 7681],
        runtime: "node24",
      });
      console.log(`${logPrefix}Sandbox created: ${sandbox.sandboxId}`);
      await createFreshNextJS(sandbox);
    } else {
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${targetOwner}/${targetRepo}.git`,
          depth: 1,
        },
        resources: { vcpus: 2 },
        timeout: ms("7m"),
        ports: [3000, 7681],
        runtime: "node24",
      });
      console.log(`${logPrefix}Sandbox created: ${sandbox.sandboxId}`);
    }
  }

  return { sandbox, snapshotUsed };
}

/**
 * Trigger asynchronous snapshot renewal for a playground (e.g. after snapshot boot failed).
 * Fetches from the renewal endpoint, registers the new snapshot in Convex.
 * Includes deduplication: won't start renewal if already in progress.
 */
export async function triggerSnapshotRenewal(
  playgroundId: string,
  sourceOwner: string,
  sourceRepo: string,
): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.CONVEX_INTERNAL_SECRET;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

  if (!baseUrl || !secret || !convexUrl) {
    console.warn(
      "[triggerSnapshotRenewal] Missing env vars (NEXT_PUBLIC_APP_URL, CONVEX_INTERNAL_SECRET, or NEXT_PUBLIC_CONVEX_URL), skipping renewal",
    );
    return;
  }

  try {
    // Check if renewal is already in progress (deduplication)
    const { ConvexHttpClient } = await import("convex/browser");
    const client = new ConvexHttpClient(convexUrl);
    const { api } = await import("../../convex/_generated/api");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { renewing } = await client.query(
      (api.snapshots as any).isSnapshotRenewing,
      {
        playgroundId,
      },
    );

    if (renewing) {
      console.log(
        `[triggerSnapshotRenewal] ${playgroundId} already renewing, skipping duplicate`,
      );
      return;
    }

    // Mark as renewing before starting (deduplication guard)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.mutation((api.snapshots as any).markSnapshotRenewing, {
      playgroundId,
    });

    // Start renewal
    console.log(
      `[triggerSnapshotRenewal] Starting renewal for ${playgroundId}...`,
    );
    const response = await fetch(`${baseUrl}/api/snapshots/renew`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": secret,
      },
      body: JSON.stringify({
        playgroundId,
        sourceOwner,
        sourceRepo,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const errMsg =
        typeof errorBody?.error === "string"
          ? errorBody.error
          : `HTTP ${response.status}`;
      console.error(`[triggerSnapshotRenewal] ${playgroundId} failed:`, errMsg);

      // Revert to active on failure
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.mutation(
        (api.snapshots as any).revertSnapshotRenewingToActive,
        {
          playgroundId,
          lastRenewalError: errMsg,
        },
      );
      return;
    }

    const data = await response.json();
    console.log(
      `[triggerSnapshotRenewal] ${playgroundId} renewed: ${data.snapshotId}`,
    );

    // Register the new snapshot
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.mutation((api.snapshots as any).registerOrUpdateSnapshot, {
      playgroundId: data.playgroundId,
      snapshotId: data.snapshotId,
      sourceOwner,
      sourceRepo,
      flavor: data.flavor,
      setupVersion: data.setupVersion,
      capabilities: data.capabilities,
    });
  } catch (err) {
    console.error(`[triggerSnapshotRenewal] ${playgroundId} error:`, err);
  }
}

/**
 * Resolve effective owner/repo and playground for sandbox creation.
 */
export function resolvePlayground(targetOwner: string, targetRepo: string) {
  const effectiveOwner =
    targetOwner === "_create" || targetOwner === "fresh"
      ? "create"
      : targetOwner;
  const effectiveRepo = targetRepo;
  const playground = PLAYGROUNDS.find(
    (p) => p.owner === effectiveOwner && p.repo === effectiveRepo,
  );
  return { effectiveOwner, effectiveRepo, playground };
}
