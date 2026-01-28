import { Sandbox } from "e2b";
import { NextResponse } from "next/server";

// TypeScript interface for the request body
interface CreateSandboxRequest {
  // The skill source (from URL)
  skillOwner: string;
  skillRepo: string;
  skillName: string;
  // The target repo to clone and use the skill on
  targetOwner: string;
  targetRepo: string;
}

export async function POST(request: Request) {
  let sbx: Sandbox | null = null;
  
  try {
    // 1. Parse and validate the request body
    const body: CreateSandboxRequest = await request.json();
    const { skillOwner, skillRepo, skillName, targetOwner, targetRepo } = body;

    if (!skillOwner || !skillRepo || !skillName) {
      return NextResponse.json(
        { error: "Missing required skill fields: skillOwner, skillRepo, skillName" },
        { status: 400 }
      );
    }

    if (!targetOwner || !targetRepo) {
      return NextResponse.json(
        { error: "Missing required target repo fields: targetOwner, targetRepo" },
        { status: 400 }
      );
    }

    // 2. Create the E2B sandbox
    // timeoutMs: how long the sandbox stays alive (5 minutes here)
    sbx = await Sandbox.create({ timeoutMs: 300_000 });
    console.log(`Sandbox created: ${sbx.sandboxId}`);

    // 3. Clone the TARGET repository (the Vercel repo to use the skill on)
    // First, let's check the environment and create a project directory
    const pwdResult = await sbx.commands.run("pwd && ls -la");
    console.log(`Current directory: ${pwdResult.stdout}`);
    
    // Create a project directory and clone into it
    await sbx.commands.run("mkdir -p /home/user/project");
    
    try {
      const cloneResult = await sbx.commands.run(
        `git clone https://github.com/${targetOwner}/${targetRepo}.git /home/user/project`,
        { timeoutMs: 120_000 } // 2 min timeout for large repos
      );
      console.log(`Clone stdout: ${cloneResult.stdout}`);
      console.log(`Clone stderr: ${cloneResult.stderr}`);
    } catch (cloneError: unknown) {
      // Extract error details from CommandExitError
      const errorDetails = cloneError instanceof Error 
        ? JSON.stringify(cloneError, Object.getOwnPropertyNames(cloneError), 2)
        : String(cloneError);
      console.error(`Git clone error details: ${errorDetails}`);
      throw new Error(`Git clone failed for ${targetOwner}/${targetRepo}. Check if the repository exists and is public.`);
    }
    
    // Change to the project directory for subsequent commands
    console.log(`Cloned target repo: ${targetOwner}/${targetRepo}`);

    // 4. Installing TTYD to access the claude cli
    // Try with sudo first, if that fails, download the binary directly
    try {
      await sbx.commands.run(
        "sudo apt-get update && sudo apt-get install -y ttyd",
        { timeoutMs: 120_000 }
      );
      console.log("TTYD installed via apt-get");
    } catch (aptError) {
      console.log("apt-get failed, downloading TTYD binary directly...");
      // Download TTYD binary directly from GitHub releases
      await sbx.commands.run(
        `curl -L -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x /tmp/ttyd`,
        { timeoutMs: 60_000 }
      );
      // Move to a location in PATH
      await sbx.commands.run("sudo mv /tmp/ttyd /usr/local/bin/ttyd || mv /tmp/ttyd /home/user/ttyd");
      console.log("TTYD installed via binary download");
    }

    // 5. Inject the skill from the skill source repo (in the project directory)
    try {
      const skillAddResult = await sbx.commands.run(
        `cd /home/user/project && npx skills add ${skillOwner}/${skillRepo} --skill ${skillName}`,
        { timeoutMs: 120_000 }
      );
      console.log(`Added skill: ${skillName} from ${skillOwner}/${skillRepo}`);
      console.log(`Skill add stdout: ${skillAddResult.stdout}`);
    } catch (skillError) {
      console.warn(`Skill add failed (continuing anyway): ${skillError}`);
    }

    // 6. Start TTYD in the background in the project directory
    // "claude": the command to run inside the terminal (Claude CLI)
    // background: true means the command runs without blocking
    // Use PATH that includes both /usr/local/bin and /home/user
    await sbx.commands.run(
      "cd /home/user/project && (ttyd -p 7681 bash || /usr/local/bin/ttyd -p 7681 bash || /home/user/ttyd -p 7681 bash)",
      { background: true }
    );
    console.log("TTYD started");

    // 7. Get the public URL for the TTYD port
    const ttydUrl = `https://${sbx.getHost(7681)}`;

    // 8. Return the sandbox info to the client
    return NextResponse.json({
      sandboxId: sbx.sandboxId,
      ttydUrl,
      status: "ready",
      targetRepo: `${targetOwner}/${targetRepo}`,
      skill: `${skillOwner}/${skillRepo}/${skillName}`,
    });
  } catch (error) {
    console.error("Sandbox creation failed:", error);
    
    // Try to kill the sandbox if it was created but something failed
    if (sbx) {
      try {
        await sbx.kill();
        console.log(`Killed failed sandbox: ${sbx.sandboxId}`);
      } catch (killError) {
        console.error("Failed to kill sandbox:", killError);
      }
    }
    
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
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