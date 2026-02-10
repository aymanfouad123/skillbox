import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import ms from "ms";
import { CLI_PROVIDERS } from "../../../lib/sandbox-utils";
import { OPENCODE_SNAPSHOT_SETUP_VERSION } from "../../../../convex/constants";

// =============================================================================
// Internal Secret Validation
// =============================================================================

function validateInternalSecret(request: Request): boolean {
  const secret = request.headers.get("X-Internal-Secret");
  const expectedSecret = process.env.CONVEX_INTERNAL_SECRET;

  if (!expectedSecret) {
    console.warn("[snapshot renew] CONVEX_INTERNAL_SECRET is not set");
    return false;
  }

  if (secret === null || secret === "") {
    return false;
  }

  const hashIncoming = crypto
    .createHash("sha256")
    .update(secret, "utf8")
    .digest();
  const hashExpected = crypto
    .createHash("sha256")
    .update(expectedSecret, "utf8")
    .digest();

  if (hashIncoming.length !== hashExpected.length) {
    return false;
  }

  return crypto.timingSafeEqual(hashIncoming, hashExpected);
}

// =============================================================================
// POST Handler - Renew Snapshot
// =============================================================================

interface RenewSnapshotRequest {
  playgroundId: string;
  sourceOwner: string;
  sourceRepo: string;
}

export async function POST(request: Request) {
  // Validate internal secret
  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let sandbox: Sandbox | null = null;

  try {
    const body: RenewSnapshotRequest = await request.json();
    const { playgroundId, sourceOwner, sourceRepo } = body;

    if (!playgroundId || !sourceOwner || !sourceRepo) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    console.log(`[Snapshot Renew] Creating sandbox for ${playgroundId}...`);

    // Determine how to create the sandbox based on source
    const isCreateNew = sourceOwner === "create" && sourceRepo === "nextjs";

    // NOTE: All current playgrounds use Node.js (commerce, chat, new-nextjs).
    // If adding Python/Go/Java playgrounds, detect project type and use appropriate runtime.
    if (isCreateNew) {
      // Fresh Next.js project
      sandbox = await Sandbox.create({
        resources: { vcpus: 2 },
        timeout: ms("15m"), // More time for setup
        ports: [3000],
        runtime: "node24",
      });

      console.log(`[Snapshot Renew] Running create-next-app...`);

      // Create Next.js project
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

      if (createResult.exitCode !== 0) {
        const stderr = await createResult.stderr();
        throw new Error(`create-next-app failed: ${stderr}`);
      }

      // Copy to sandbox directory
      await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-c",
          "cp -r /tmp/nextjs-project/* /vercel/sandbox/ && " +
            "cp -r /tmp/nextjs-project/.[!.]* /vercel/sandbox/ 2>/dev/null || true && " +
            "rm -rf /tmp/nextjs-project",
        ],
      });
    } else {
      // Clone from git
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${sourceOwner}/${sourceRepo}.git`,
          depth: 1,
        },
        resources: { vcpus: 2 },
        timeout: ms("15m"),
        ports: [3000],
        runtime: "node24",
      });
    }

    console.log(`[Snapshot Renew] Sandbox created: ${sandbox.sandboxId}`);

    // Install dependencies
    console.log(`[Snapshot Renew] Installing dependencies...`);

    // Check for pnpm
    const pnpmLock = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/pnpm-lock.yaml" });
    const usePnpm = pnpmLock != null;

    const installCmd = usePnpm ? "pnpm" : "npm";
    const installResult = await sandbox.runCommand({
      cmd: installCmd,
      args: ["install"],
      cwd: "/vercel/sandbox",
    });

    if (installResult.exitCode !== 0) {
      const stderr = await installResult.stderr();
      console.warn(`[Snapshot Renew] Install warning: ${stderr}`);
      // Continue anyway - some projects might not need install
    }

    console.log(`[Snapshot Renew] Dependencies installed (${installCmd})`);

    // Install and configure OpenCode so snapshots are prebaked (skip at boot)
    const opencode = CLI_PROVIDERS.opencode;
    console.log(`[Snapshot Renew] Installing ${opencode.name} CLI...`);
    const cliResult = await sandbox.runCommand({
      cmd: opencode.installCommand.cmd,
      args: opencode.installCommand.args,
      sudo: true,
    });
    if (cliResult.exitCode !== 0) {
      const stderr = await cliResult.stderr();
      throw new Error(`OpenCode install failed: ${stderr}`);
    }
    console.log(`[Snapshot Renew] Configuring ${opencode.name}...`);
    await opencode.configSetup(sandbox);

    // Create snapshot - this stops the sandbox automatically
    console.log(`[Snapshot Renew] Creating snapshot...`);
    const snapshot = await sandbox.snapshot();

    console.log(
      `[Snapshot Renew] Snapshot created: ${snapshot.snapshotId} for ${playgroundId}`
    );

    // sandbox.snapshot() stops the sandbox, so set to null to avoid double-stop
    sandbox = null;

    return NextResponse.json({
      success: true,
      snapshotId: snapshot.snapshotId,
      playgroundId,
      flavor: "opencode",
      setupVersion: OPENCODE_SNAPSHOT_SETUP_VERSION,
      capabilities: ["opencode_cli", "opencode_config"],
    });
  } catch (error) {
    console.error("[Snapshot Renew] Failed:", error);

    // Clean up sandbox if it exists
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        // Ignore cleanup errors
      }
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
