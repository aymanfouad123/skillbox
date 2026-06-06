import { v } from "convex/values";
import {
  mutation,
  query,
  action,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  MAX_SANDBOXES,
  HEARTBEAT_TIMEOUT_MS,
  CLAUDE_FULFILL_TIMEOUT_MS,
  SESSION_DURATION_MS,
  EXTEND_TIMEOUT_MS,
} from "./constants";

// =============================================================================
// On-demand maintenance (replaces cron-driven cleanup/queue jobs)
// =============================================================================

async function archiveExpiredActiveSandboxes(ctx: MutationCtx) {
  const now = Date.now();
  const expired = await ctx.db
    .query("sandboxes")
    .withIndex("by_status", (q) => q.eq("status", "active"))
    .filter((q) => q.lt(q.field("expiresAt"), now))
    .collect();

  for (const sandbox of expired) {
    console.log(
      `[Session ended] Expired: ${sandbox.sandboxId} (userId: ${sandbox.userId})`
    );
    await ctx.db.patch(sandbox._id, {
      status: "archived",
      archivedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.sandboxes.stopVercelSandbox, {
      sandboxId: sandbox.sandboxId,
    });
  }

  if (expired.length > 0) {
    console.log(`[Session ended] Cleanup: ${expired.length} expired sandbox(es)`);
  }
  return expired.length;
}

async function cleanupStaleClaudeQueueEntries(ctx: MutationCtx) {
  const now = Date.now();
  const staleEntries = await ctx.db
    .query("queue")
    .withIndex("by_cliProvider_queueExpiresAt", (q) =>
      q.eq("cliProvider", "claude").lt("queueExpiresAt", now)
    )
    .collect();

  for (const entry of staleEntries) {
    console.log(
      `Removing stale Claude queue entry for user ${entry.userId} (heartbeat expired)`
    );
    await ctx.db.delete(entry._id);
  }
  return staleEntries.length;
}

async function handleSlowClaudeUserAtHead(ctx: MutationCtx) {
  const now = Date.now();
  const queue = await ctx.db
    .query("queue")
    .withIndex("by_position")
    .order("asc")
    .collect();

  const firstEntry = queue[0];
  if (!firstEntry) return 0;
  if (firstEntry.cliProvider !== "claude") return 0;
  if (!firstEntry.readyToFulfillAt) return 0;

  const readyDuration = now - firstEntry.readyToFulfillAt;
  if (readyDuration < CLAUDE_FULFILL_TIMEOUT_MS) return 0;

  console.log(
    `Kicking slow Claude user ${firstEntry.userId} to back of queue (ready for ${Math.round(readyDuration / 1000)}s)`
  );

  const lastInQueue = await ctx.db
    .query("queue")
    .withIndex("by_position")
    .order("desc")
    .first();

  const newPosition = lastInQueue ? lastInQueue.position + 1 : 1;

  await ctx.db.patch(firstEntry._id, {
    position: newPosition,
    readyToFulfillAt: undefined,
    lastHeartbeat: now,
    queueExpiresAt: now + HEARTBEAT_TIMEOUT_MS,
  });

  return 1;
}

async function runOnDemandMaintenance(ctx: MutationCtx) {
  const expiredCount = await archiveExpiredActiveSandboxes(ctx);
  const staleRemoved = await cleanupStaleClaudeQueueEntries(ctx);
  await handleSlowClaudeUserAtHead(ctx);
  return { expiredCount, staleRemoved };
}

function isQueueEntryLive(
  entry: { cliProvider: string; queueExpiresAt?: number },
  now: number
) {
  if (entry.cliProvider !== "claude") return true;
  return entry.queueExpiresAt === undefined || entry.queueExpiresAt >= now;
}

async function countLiveActiveSandboxes(ctx: QueryCtx | MutationCtx) {
  const now = Date.now();
  const active = await ctx.db
    .query("sandboxes")
    .withIndex("by_status", (q) => q.eq("status", "active"))
    .collect();
  return active.filter((s) => s.expiresAt > now).length;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Get the count of active sandboxes
 */
export const getActiveSandboxCount = query({
  args: {},
  handler: async (ctx) => {
    return countLiveActiveSandboxes(ctx);
  },
});

/**
 * Check if there's capacity and if user already has a sandbox/queue entry
 */
export const getUserStatus = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check for active sandbox (ignore expired rows until on-demand cleanup runs)
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (sandbox && sandbox.expiresAt > now) {
      return {
        type: "sandbox" as const,
        sandboxId: sandbox.sandboxId,
        ttydUrl: sandbox.ttydUrl,
        previewUrl: sandbox.previewUrl,
        previewReady: sandbox.previewReady ?? false,
        expiresAt: sandbox.expiresAt,
        // Vercel timing for accurate countdown
        vercelCreatedAt: sandbox.vercelCreatedAt,
        vercelTimeout: sandbox.vercelTimeout,
        hasExtendedTimeout: sandbox.hasExtendedTimeout ?? false,
      };
    }

    // Check for queue entry
    const queueEntry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (queueEntry && isQueueEntryLive(queueEntry, now)) {
      // Count position (exclude stale Claude entries)
      const ahead = await ctx.db
        .query("queue")
        .withIndex("by_position")
        .filter((q) => q.lt(q.field("position"), queueEntry.position))
        .collect();

      const position =
        ahead.filter((entry) => isQueueEntryLive(entry, now)).length + 1;

      // For Claude users at position 1, check if capacity is available
      // Frontend will handle sandbox creation with API key from localStorage
      let readyToFulfill = false;
      if (queueEntry.cliProvider === "claude" && position === 1) {
        const activeCount = await countLiveActiveSandboxes(ctx);
        readyToFulfill = activeCount < MAX_SANDBOXES;
      }

      return {
        type: "queued" as const,
        position,
        queueId: queueEntry._id,
        cliProvider: queueEntry.cliProvider,
        skill: queueEntry.skill,
        readyToFulfill,
      };
    }

    // Check capacity
    const activeCount = await countLiveActiveSandboxes(ctx);

    return {
      type: "idle" as const,
      hasCapacity: activeCount < MAX_SANDBOXES,
      activeCount,
    };
  },
});

// =============================================================================
// Public Mutations
// =============================================================================

/**
 * Register a new sandbox (called by frontend AFTER successful API creation)
 * This ensures we only store complete, valid data
 */
export const registerSandbox = mutation({
  args: {
    userId: v.string(),
    sandboxId: v.string(),
    ttydUrl: v.string(),
    previewUrl: v.optional(v.string()),
    skill: v.string(),
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    // Vercel timing from SDK for accurate countdown
    vercelCreatedAt: v.optional(v.number()),
    vercelTimeout: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await runOnDemandMaintenance(ctx);

    const now = Date.now();

    // Check if user already has an active sandbox
    const existing = await ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (existing && existing.expiresAt > now) {
      return { success: false, error: "already_exists" };
    }

    // Verify we're still under capacity (handle race condition gracefully)
    const activeCount = await countLiveActiveSandboxes(ctx);

    if (activeCount >= MAX_SANDBOXES) {
      // Race condition: we're now over capacity
      // The Vercel sandbox will expire naturally, just don't register it
      return { success: false, error: "at_capacity" };
    }

    // Calculate expiration based on Vercel timing if available
    // This accounts for setup time that already elapsed
    let expiresAt = now + SESSION_DURATION_MS;
    if (args.vercelCreatedAt && args.vercelTimeout) {
      // Vercel sandbox will expire at: vercelCreatedAt + vercelTimeout
      // Use that as our expiration, minus a small buffer for cleanup
      const vercelExpiresAt = args.vercelCreatedAt + args.vercelTimeout;
      expiresAt = Math.min(expiresAt, vercelExpiresAt - 30000); // 30s buffer
    }

    // Create the sandbox record with complete data (previewReady starts false; updated when probe succeeds)
    await ctx.db.insert("sandboxes", {
      userId: args.userId,
      sandboxId: args.sandboxId,
      ttydUrl: args.ttydUrl,
      previewUrl: args.previewUrl,
      previewReady: false,
      skill: args.skill,
      cliProvider: args.cliProvider,
      status: "active",
      createdAt: now,
      expiresAt,
      vercelCreatedAt: args.vercelCreatedAt,
      vercelTimeout: args.vercelTimeout,
      hasExtendedTimeout: false,
    });

    // Increment analytics
    await ctx.scheduler.runAfter(0, internal.analytics.incrementSandboxCount, {
      cliProvider: args.cliProvider,
    });

    return { success: true };
  },
});

/**
 * Add user to queue when at capacity
 */
export const addToQueue = mutation({
  args: {
    userId: v.string(),
    skill: v.string(),
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
  },
  handler: async (ctx, args) => {
    await runOnDemandMaintenance(ctx);

    // Check if already in queue
    const existing = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (existing) {
      const ahead = await ctx.db
        .query("queue")
        .withIndex("by_position")
        .filter((q) => q.lt(q.field("position"), existing.position))
        .collect();
      return { success: true, position: ahead.length + 1, alreadyQueued: true };
    }

    // Check if user has active sandbox
    const activeSandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (activeSandbox) {
      return { success: false, error: "has_active_sandbox" };
    }

    // Get next position
    const lastInQueue = await ctx.db
      .query("queue")
      .withIndex("by_position")
      .order("desc")
      .first();

    const position = lastInQueue ? lastInQueue.position + 1 : 1;
    const now = Date.now();

    // For Claude users, set initial heartbeat and expiry
    const heartbeatFields =
      args.cliProvider === "claude"
        ? {
            lastHeartbeat: now,
            queueExpiresAt: now + HEARTBEAT_TIMEOUT_MS,
          }
        : {};

    await ctx.db.insert("queue", {
      userId: args.userId,
      position,
      skill: args.skill,
      cliProvider: args.cliProvider,
      createdAt: now,
      ...heartbeatFields,
    });

    // Event-triggered queue processing (replaces cron)
    await ctx.scheduler.runAfter(0, internal.queue.processQueue, {});

    return { success: true, position };
  },
});

/**
 * Cancel queue entry
 */
export const cancelQueue = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (entry) {
      await ctx.db.delete(entry._id);
      await ctx.scheduler.runAfter(0, internal.queue.processQueue, {});
      return { success: true };
    }

    return { success: false, error: "not_found" };
  },
});

/**
 * Send heartbeat for Claude users in queue
 * Called every 10 seconds by frontend to prove browser is still connected
 */
export const sendHeartbeat = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await runOnDemandMaintenance(ctx);

    const entry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!entry) {
      return { success: false, error: "not_in_queue" };
    }

    // Only Claude users need heartbeats
    if (entry.cliProvider !== "claude") {
      return { success: true };
    }

    const now = Date.now();
    await ctx.db.patch(entry._id, {
      lastHeartbeat: now,
      queueExpiresAt: now + HEARTBEAT_TIMEOUT_MS,
    });

    return { success: true };
  },
});

/**
 * Remove from queue immediately (called on beforeunload)
 * Uses sendBeacon so must be fire-and-forget friendly
 */
export const removeFromQueue = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (entry) {
      await ctx.db.delete(entry._id);
      await ctx.scheduler.runAfter(0, internal.queue.processQueue, {});
    }
    // Always return success - fire-and-forget
    return { success: true };
  },
});

/**
 * Claim queue slot for client-side fulfillment (Claude BYOK)
 * Atomically removes user from queue so frontend can create sandbox with API key
 */
export const claimQueueSlot = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    await runOnDemandMaintenance(ctx);

    const now = Date.now();

    // Find the queue entry
    const entry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!entry) {
      return { success: false, error: "not_in_queue" };
    }

    // Verify they're at position 1 (exclude stale Claude entries)
    const ahead = await ctx.db
      .query("queue")
      .withIndex("by_position")
      .filter((q) => q.lt(q.field("position"), entry.position))
      .collect();

    const liveAhead = ahead.filter((e) => isQueueEntryLive(e, now));
    if (liveAhead.length > 0) {
      return { success: false, error: "not_first_in_queue" };
    }

    // Verify capacity is available
    const activeCount = await countLiveActiveSandboxes(ctx);

    if (activeCount >= MAX_SANDBOXES) {
      return { success: false, error: "no_capacity" };
    }

    // Remove from queue - frontend will now create the sandbox
    await ctx.db.delete(entry._id);

    return {
      success: true,
      skill: entry.skill,
      cliProvider: entry.cliProvider,
    };
  },
});

/**
 * Stop a sandbox
 */
export const stopSandbox = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (!sandbox) {
      return { success: false, error: "not_found" };
    }

    // Archive immediately (optimistic)
    await ctx.db.patch(sandbox._id, {
      status: "archived",
      archivedAt: Date.now(),
    });

    console.log(`[Session ended] User kill: ${sandbox.sandboxId} (userId: ${args.userId})`);

    // Schedule actual Vercel sandbox stop
    await ctx.scheduler.runAfter(0, internal.sandboxes.stopVercelSandbox, {
      sandboxId: sandbox.sandboxId,
    });

    // Process queue after stopping
    await ctx.scheduler.runAfter(500, internal.queue.processQueue, {});

    return { success: true };
  },
});

/**
 * Extend sandbox timeout (one-time only)
 * Calls Vercel PATCH first; only updates Convex if Vercel extend succeeds
 */
export const extendTimeout = action({
  args: { userId: v.string() },
  handler: async (
    ctx,
    args
  ): Promise<
    | { success: true; newExpiresAt: number }
    | { success: false; error: string }
  > => {
    const sandbox = await ctx.runQuery(internal.sandboxes.getSandboxForExtend, {
      userId: args.userId,
    });

    if (!sandbox) {
      return { success: false, error: "not_found" };
    }

    if (sandbox.hasExtendedTimeout) {
      return { success: false, error: "already_extended" };
    }

    // Call Vercel PATCH first - only update Convex if it succeeds
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const response = await fetch(`${baseUrl}/api/sandbox/internal`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.CONVEX_INTERNAL_SECRET || "",
      },
      body: JSON.stringify({
        sandboxId: sandbox.sandboxId,
        action: "extend",
        duration: EXTEND_TIMEOUT_MS,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error("Vercel extend failed:", err);
      return {
        success: false,
        error: (err as { error?: string }).error || "vercel_extend_failed",
      };
    }

    const newExpiresAt = sandbox.expiresAt + EXTEND_TIMEOUT_MS;
    await ctx.runMutation(internal.sandboxes.updateSandboxAfterExtend, {
      sandboxId: sandbox._id,
      newExpiresAt,
    });

    return { success: true, newExpiresAt };
  },
});

// =============================================================================
// Internal Queries
// =============================================================================

/**
 * Get active sandbox for extend flow (used by extendTimeout action)
 */
export const getSandboxForExtend = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
  },
});

// =============================================================================
// Internal Mutations (called by crons and actions)
// =============================================================================

/**
 * Update sandbox after successful Vercel extend
 */
export const updateSandboxAfterExtend = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    newExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sandboxId, {
      expiresAt: args.newExpiresAt,
      hasExtendedTimeout: true,
    });
  },
});

/**
 * Mark preview as ready after dev server readiness probe succeeds (called from API background warm-up)
 */
export const markPreviewReady = internalMutation({
  args: { sandboxId: v.string() },
  handler: async (ctx, args) => {
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (sandbox) {
      await ctx.db.patch(sandbox._id, { previewReady: true });
    }
  },
});

/**
 * Register sandbox from queue processing (internal)
 */
export const registerSandboxInternal = internalMutation({
  args: {
    queueId: v.id("queue"),
    userId: v.string(),
    sandboxId: v.string(),
    ttydUrl: v.string(),
    previewUrl: v.optional(v.string()),
    skill: v.string(),
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    vercelCreatedAt: v.optional(v.number()),
    vercelTimeout: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Calculate expiration based on Vercel timing if available
    let expiresAt = now + SESSION_DURATION_MS;
    if (args.vercelCreatedAt && args.vercelTimeout) {
      const vercelExpiresAt = args.vercelCreatedAt + args.vercelTimeout;
      expiresAt = Math.min(expiresAt, vercelExpiresAt - 30000);
    }

    // Create sandbox (previewReady starts false; updated when probe succeeds)
    await ctx.db.insert("sandboxes", {
      userId: args.userId,
      sandboxId: args.sandboxId,
      ttydUrl: args.ttydUrl,
      previewUrl: args.previewUrl,
      previewReady: false,
      skill: args.skill,
      cliProvider: args.cliProvider,
      status: "active",
      createdAt: now,
      expiresAt,
      vercelCreatedAt: args.vercelCreatedAt,
      vercelTimeout: args.vercelTimeout,
      hasExtendedTimeout: false,
    });

    // Delete queue entry
    await ctx.db.delete(args.queueId);

    // Increment analytics
    await ctx.scheduler.runAfter(0, internal.analytics.incrementSandboxCount, {
      cliProvider: args.cliProvider,
    });
  },
});

/**
 * Delete queue entry on failure (internal)
 */
export const deleteQueueEntry = internalMutation({
  args: { queueId: v.id("queue") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.queueId);
    if (entry) {
      await ctx.db.delete(args.queueId);
    }
  },
});

/**
 * Cleanup expired sandboxes (called by cron)
 */
export const cleanupExpiredSandboxes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expiredCount = await archiveExpiredActiveSandboxes(ctx);
    return { expiredCount };
  },
});

// =============================================================================
// Internal Actions (for calling external APIs)
// =============================================================================

/**
 * Stop the Vercel sandbox via API
 * Handles already-stopped sandboxes gracefully
 */
export const stopVercelSandbox = internalAction({
  args: { sandboxId: v.string() },
  handler: async (_ctx, args) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    try {
      const response = await fetch(`${baseUrl}/api/sandbox/internal`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.CONVEX_INTERNAL_SECRET || "",
        },
        body: JSON.stringify({ sandboxId: args.sandboxId }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        // Sandbox may already be stopped - that's fine
        if (
          error.error?.includes("not found") ||
          error.error?.includes("stopped")
        ) {
          console.log(`Sandbox ${args.sandboxId} already stopped`);
          return;
        }
        console.error("Failed to stop sandbox:", error);
      }
    } catch (error) {
      // Network errors or sandbox already gone - log but don't throw
      console.error("Failed to stop Vercel sandbox:", error);
    }
  },
});

