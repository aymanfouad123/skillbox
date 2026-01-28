import { Sandbox } from "e2b";
import { NextResponse } from "next/server";

// TypeScript interface for the request body
interface CreateSandboxRequest {
  owner: string; 
  repo: string;   
  skills: Array<{ name: string; author: string; }>;
}

export async function POST(request: Request) {
  try {
    // 1. Parse and validate the request body
    const body: CreateSandboxRequest = await request.json();
    const { owner, repo, skills } = body;

    if (!owner || !repo) {
      return NextResponse.json(
        { error: "Missing required fields: owner and repo" },
        { status: 400 }
      );
    }

    // 2. Create the E2B sandbox
    // timeoutMs: how long the sandbox stays alive (5 minutes here)
    const sbx = await Sandbox.create({ timeoutMs: 300_000 });

    console.log(`Sandbox created: ${sbx.sandboxId}`);

    // 3. Clone the GitHub repository
    await sbx.commands.run(
      `git clone https://github.com/${owner}/${repo}.git .`
    );
    
    console.log(`Cloned ${owner}/${repo}`);

    // 4. Installing TTYD to access the claude cli
    await sbx.commands.run(
      "apt-get update && apt-get install -y ttyd",
      { timeoutMs: 120_000 } // 2 min timeout for apt operations
    );
    console.log("TTYD installed");

    // 5. Inject each skill using the skills CLI
    for (const skill of skills || []) {
      await sbx.commands.run(
        `npx skills add ${skill.author} --skill ${skill.name}`
      );
      console.log(`Added skill: ${skill.name}`);
    }

    // 6. Start TTYD in the background
    // "claude": the command to run inside the terminal (Claude CLI)
    // background: true means the command runs without blocking
    await sbx.commands.run("ttyd -p 7681 claude", { background: true });
    console.log("TTYD started");

    // 7. Get the public URL for the TTYD port
    const ttydUrl = `https://${sbx.getHost(7681)}`;

    // 8. Return the sandbox info to the client
    return NextResponse.json({
      sandboxId: sbx.sandboxId,
      ttydUrl,
      status: "ready",
    });
  } catch (error) {
    console.error("Sandbox creation failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}