import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import ms from "ms";

interface CreateSandboxRequest {
  skillOwner: string;
  skillRepo: string;
  skillName: string;
  targetOwner: string;
  targetRepo: string;
  anthropicApiKey: string;
}

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
      anthropicApiKey,
    } = body;

    // Validation
    if (
      !skillOwner ||
      !skillRepo ||
      !skillName ||
      !targetOwner ||
      !targetRepo ||
      !anthropicApiKey
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const isCreateNew = targetOwner === "_create";

    console.log(
      isCreateNew
        ? `Creating sandbox with fresh ${targetRepo} project and skill ${skillName}...`
        : `Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}...`,
    );

    // 1. Create Sandbox with Vercel Sandbox SDK
    if (isCreateNew && targetRepo === "nextjs") {
      // For fresh Next.js, create empty sandbox and run create-next-app
      sandbox = await Sandbox.create({
        resources: { vcpus: 4 },
        timeout: ms("5m"),
        ports: [7681],
        runtime: "node22",
      });

      console.log(`Sandbox created: ${sandbox.sandboxId}`);
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
          "--use-npm",
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
    } else {
      // Clone existing repo for other playgrounds
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${targetOwner}/${targetRepo}.git`,
          depth: 1,
        },
        resources: { vcpus: 4 },
        timeout: ms("3m"),
        ports: [7681],
        runtime: "node22",
      });

      console.log(`Sandbox created: ${sandbox.sandboxId}`);
    }

    // 2. Install Claude CLI
    console.log("Installing Claude CLI...");
    const claudeInstall = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
    });

    if (claudeInstall.exitCode !== 0) {
      console.warn(`Claude CLI install warning: ${claudeInstall.stderr}`);
    }

    // 3. Install TTYD (download binary directly)
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

    // Determine ttyd path
    const ttydPath =
      ttydInstall.exitCode === 0 ? "ttyd" : "/vercel/sandbox/ttyd";
    console.log(`TTYD installed at: ${ttydPath}`);

    // 4. Inject the Skill (with --yes to avoid interactive prompts)
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
      console.warn(`Skill add warning (continuing): ${skillResult.stderr}`);
    }
    console.log("Skill injection completed");

    // 5. Pre-configure Claude CLI to skip onboarding
    console.log("Setting up Claude CLI configuration...");
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

    // 6. Launch ttyd with Claude CLI in detached mode
    console.log("Launching Claude Agent...");
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
          `export ANTHROPIC_API_KEY='${anthropicApiKey}' ` +
          `FORCE_COLOR=1 ` +
          `TERM=xterm-256color ` +
          `COLORTERM=truecolor ` +
          `EDITOR=cat ` +
          `VISUAL=cat && ` +
          `exec claude` +
          `"`,
      ],
      detached: true,
    });

    // Wait for TTYD to be ready
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

    if (!ready) console.warn("TTYD timed out but returning URL anyway.");

    // Give TTYD and Claude additional time to fully initialize
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

// DELETE handler to stop a sandbox
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
