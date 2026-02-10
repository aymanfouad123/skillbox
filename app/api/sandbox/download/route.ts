import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";

// Lazy Convex client for ownership check
let convexClient: ConvexHttpClient | null = null;
function getConvexClient(): ConvexHttpClient | null {
  if (convexClient !== null) return convexClient;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  convexClient = new ConvexHttpClient(url);
  return convexClient;
}

/**
 * POST /api/sandbox/download
 * Body: { sandboxId: string, userId: string }
 * Streams the sandbox workspace as a tarball using sandbox.runCommand (tar) and
 * sandbox.readFile (stream) per sandbox-sdk.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sandboxId, userId } = body as { sandboxId?: string; userId?: string };

    if (!sandboxId || !userId) {
      return NextResponse.json(
        { error: "Missing sandboxId or userId" },
        { status: 400 }
      );
    }

    // Verify the user owns this active sandbox (Convex)
    const convex = getConvexClient();
    if (!convex) {
      return NextResponse.json(
        { error: "Service unavailable" },
        { status: 503 }
      );
    }

    const userStatus = await convex.query(api.sandboxes.getUserStatus, {
      userId,
    });

    if (!userStatus || userStatus.type !== "sandbox" || userStatus.sandboxId !== sandboxId) {
      return NextResponse.json(
        { error: "Sandbox not found or access denied" },
        { status: 403 }
      );
    }

    if (!process.env.VERCEL_OIDC_TOKEN) {
      return NextResponse.json(
        { error: "Sandbox access unavailable" },
        { status: 503 }
      );
    }

    const sandbox = await Sandbox.get({ sandboxId });

    if (sandbox.status !== "running") {
      return NextResponse.json(
        { error: "Sandbox is not running" },
        { status: 400 }
      );
    }

    // Create tarball of /vercel/sandbox in the microVM
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        "tar czf /tmp/repo.tar.gz -C /vercel/sandbox .",
      ],
      cwd: "/vercel/sandbox",
    });

    const stream = await sandbox.readFile({ path: "/tmp/repo.tar.gz" });
    if (stream == null) {
      return NextResponse.json(
        { error: "Failed to create archive" },
        { status: 500 }
      );
    }

    const filename = "sandbox-repo.tar.gz";
    return new Response(stream as unknown as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("Sandbox download failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Download failed" },
      { status: 500 }
    );
  }
}
