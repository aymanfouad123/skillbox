import { Sandbox } from "e2b";
import { NextResponse } from "next/server";

interface CreateSandboxRequest {
  skillOwner: string;
  skillRepo: string;
  skillName: string;
  targetOwner: string;
  targetRepo: string;
  anthropicApiKey: string;
}

// Helper to run commands and log results (doesn't throw on non-zero exit)
async function runCommand(
  sbx: Sandbox, 
  cmd: string, 
  opts?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await sbx.commands.run(cmd, opts);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    // e2b throws on non-zero exit codes, extract the info
    if (error && typeof error === 'object' && 'result' in error) {
      const cmdError = error as { result: { stdout: string; stderr: string; exitCode: number } };
      return { 
        stdout: cmdError.result?.stdout || '', 
        stderr: cmdError.result?.stderr || '', 
        exitCode: cmdError.result?.exitCode || 1 
      };
    }
    throw error;
  }
}

export async function POST(request: Request) {
  let sbx: Sandbox | null = null;
  
  try {
    const body: CreateSandboxRequest = await request.json();
    const { skillOwner, skillRepo, skillName, targetOwner, targetRepo, anthropicApiKey } = body;

    // Validation
    if (!skillOwner || !skillRepo || !skillName || !targetOwner || !targetRepo || !anthropicApiKey) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log(`Creating sandbox for ${targetOwner}/${targetRepo} with skill ${skillName}...`);

    // 1. Create Sandbox
    sbx = await Sandbox.create({ timeoutMs: 300_000 }); // 5 minutes
    console.log(`Sandbox created: ${sbx.sandboxId}`);

    // 2. Setup Project Directory
    await sbx.commands.run("mkdir -p /home/user/project");
    
    // 3. Clone Target Repository
    console.log(`Cloning ${targetOwner}/${targetRepo}...`);
    const cloneResult = await runCommand(
      sbx,
      `git clone --depth 1 https://github.com/${targetOwner}/${targetRepo}.git /home/user/project`,
      { timeoutMs: 120_000 }
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Git clone failed: ${cloneResult.stderr}`);
    }
    console.log("Repository cloned successfully");

    // 4. Install Claude CLI
    console.log("Installing Claude CLI...");
    const claudeInstall = await runCommand(
      sbx,
      "npm install -g @anthropic-ai/claude-code",
      { timeoutMs: 120_000 }
    );
    if (claudeInstall.exitCode !== 0) {
      console.warn(`Claude CLI install warning: ${claudeInstall.stderr}`);
    }

    // 5. Install TTYD (download binary directly since apt-get often fails in sandboxes)
    console.log("Installing TTYD...");
    const ttydInstall = await runCommand(
      sbx,
      `curl -sL -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && ` +
      `chmod +x /tmp/ttyd && ` +
      `mv /tmp/ttyd /usr/local/bin/ttyd || mv /tmp/ttyd /home/user/ttyd`,
      { timeoutMs: 60_000 }
    );
    
    // Determine ttyd path
    const ttydPath = ttydInstall.exitCode === 0 ? "ttyd" : "/home/user/ttyd";
    console.log(`TTYD installed at: ${ttydPath}`);

    // 6. Inject the Skill (with --yes to avoid interactive prompts)
    console.log(`Adding skill: ${skillName}...`);
    const skillResult = await runCommand(
      sbx,
      `cd /home/user/project && npx -y skills add ${skillOwner}/${skillRepo} --skill ${skillName} --yes`,
      { timeoutMs: 120_000 }
    );
    if (skillResult.exitCode !== 0) {
      console.warn(`Skill add warning (continuing): ${skillResult.stderr}`);
    }
    console.log("Skill injection completed");

    // 7. Pre-configure Claude CLI to skip onboarding (don't set primaryApiKey - use env var only)
    console.log("Setting up Claude CLI configuration...");
    const configPayload = JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "0.2.107",
      lastReleaseNotesSeen: "0.2.107",
      isQualifiedForDataSharing: false,
      changelogLastFetched: 1000000000000,
    });

    await runCommand(
      sbx,
      `mkdir -p /home/user/.claude && ` +
      `echo '${configPayload}' > /home/user/.claude.json && ` +
      `echo '${configPayload}' > /home/user/.claude/config.json && ` +
      `echo '{"theme":"dark","hasCompletedOnboarding":true,"autoUpdaterStatus":"disabled"}' > /home/user/.claude/settings.json`
    );

    // 8. Launch Claude with Color support and Persistent Connection
    console.log("Launching Claude Agent in High-Performance Mode...");
    await sbx.commands.run(
      `cd /home/user/project && ` +
      `${ttydPath} -p 7681 -W -i 0.0.0.0 -t fontSize=14 -t 'theme={"background":"#1a1a1a"}' ` +
      `bash -c "` +
        `export ANTHROPIC_API_KEY='${anthropicApiKey}' && ` +
        `export FORCE_COLOR=1 && ` +
        `export TERM=xterm-256color && ` +
        `export COLORTERM=truecolor && ` +
        `export CLAUDE_CODE_SKIP_ONBOARDING=true && ` +
        `claude config add allowedTools Edit Bash && ` +
        `claude --dangerously-skip-permissions 'Analyze this repo and specifically the ${skillName} skill I just added.' && ` +
        `exec bash` +
      `"`,
      { background: true }
    );

    // Wait for the port to be active so the user sees a ready UI
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const check = await sbx.commands.run("curl -s http://localhost:7681");
        if (check.exitCode === 0) {
          ready = true;
          break;
        }
      } catch {
        // Port not ready yet, wait and retry
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!ready) console.warn("TTYD readiness check timed out but returning URL anyway.");

    // Give TTYD and Claude additional time to fully initialize
    await new Promise(resolve => setTimeout(resolve, 3000));

    const ttydUrl = `https://${sbx.getHost(7681)}`;
    console.log(`Sandbox ready: ${ttydUrl}`);

    return NextResponse.json({
      sandboxId: sbx.sandboxId,
      ttydUrl,
      status: "ready"
    });

  } catch (error) {
    console.error("Sandbox creation failed:", error);
    if (sbx) {
      try {
        await sbx.kill();
        console.log(`Killed failed sandbox: ${sbx.sandboxId}`);
      } catch (killErr) {
        console.error("Failed to kill sandbox:", killErr);
      }
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initialize" },
      { status: 500 }
    );
  }
}

// DELETE handler to kill a sandbox
export async function DELETE(request: Request) {
  try {
    const { sandboxId } = await request.json();

    if (!sandboxId) {
      return NextResponse.json(
        { error: "Missing sandboxId" },
        { status: 400 }
      );
    }

    // Connect to existing sandbox and kill it
    const sbx = await Sandbox.connect(sandboxId);
    await sbx.kill();

    console.log(`Sandbox killed: ${sandboxId}`);

    return NextResponse.json({ success: true, sandboxId });
  } catch (error) {
    console.error("Failed to kill sandbox:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
