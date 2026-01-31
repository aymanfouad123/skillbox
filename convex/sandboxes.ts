import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";

// Maximum number of concurrent sandboxes
const MAX_SANDBOXES = 100;

// Sandbox session duration in milliseconds (6 minutes)
// Note: The Vercel backend uses 7 minutes to account for ~60-90s setup time.
// This ensures users get the full 6 minutes of actual usage time.
const SESSION_DURATION_MS = 6 * 60 * 1000;

// =============================================================================
// Queries
// =============================================================================

/**
 * Get the count of active sandboxes
 */
export const getActiveSandboxCount = query({
  args: {},
  handler: async (ctx) => {
    const active = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    return active.length;
  },
});

/**
 * Check if there's capacity and if user already has a sandbox/queue entry
 */
export const getUserStatus = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    // Check for active sandbox
    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (sandbox) {
      return {
        type: "sandbox" as const,
        sandboxId: sandbox.sandboxId,
        ttydUrl: sandbox.ttydUrl,
        expiresAt: sandbox.expiresAt,
      };
    }

    // Check for queue entry
    const queueEntry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (queueEntry) {
      // Count position
      const ahead = await ctx.db
        .query("queue")
        .withIndex("by_position")
        .filter((q) => q.lt(q.field("position"), queueEntry.position))
        .collect();

      return {
        type: "queued" as const,
        position: ahead.length + 1,
        queueId: queueEntry._id,
      };
    }

    // Check capacity
    const activeCount = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    return {
      type: "idle" as const,
      hasCapacity: activeCount.length < MAX_SANDBOXES,
      activeCount: activeCount.length,
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
    skill: v.string(),
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
  },
  handler: async (ctx, args) => {
    // Check if user already has an active sandbox
    const existing = await ctx.db
      .query("sandboxes")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (existing) {
      return { success: false, error: "already_exists" };
    }

    // Verify we're still under capacity (handle race condition gracefully)
    const activeCount = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    if (activeCount.length >= MAX_SANDBOXES) {
      // Race condition: we're now over capacity
      // The Vercel sandbox will expire naturally, just don't register it
      return { success: false, error: "at_capacity" };
    }

    const now = Date.now();

    // Create the sandbox record with complete data
    await ctx.db.insert("sandboxes", {
      userId: args.userId,
      sandboxId: args.sandboxId,
      ttydUrl: args.ttydUrl,
      skill: args.skill,
      cliProvider: args.cliProvider,
      status: "active",
      createdAt: now,
      expiresAt: now + SESSION_DURATION_MS,
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

    await ctx.db.insert("queue", {
      userId: args.userId,
      position,
      skill: args.skill,
      cliProvider: args.cliProvider,
      createdAt: Date.now(),
    });

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
      return { success: true };
    }

    return { success: false, error: "not_found" };
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

    // Schedule actual Vercel sandbox stop
    await ctx.scheduler.runAfter(0, internal.sandboxes.stopVercelSandbox, {
      sandboxId: sandbox.sandboxId,
    });

    // Process queue after stopping
    await ctx.scheduler.runAfter(500, internal.queue.processQueue, {});

    return { success: true };
  },
});

// =============================================================================
// Internal Mutations (called by crons and actions)
// =============================================================================

/**
 * Register sandbox from queue processing (internal)
 */
export const registerSandboxInternal = internalMutation({
  args: {
    queueId: v.id("queue"),
    userId: v.string(),
    sandboxId: v.string(),
    ttydUrl: v.string(),
    skill: v.string(),
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Create sandbox
    await ctx.db.insert("sandboxes", {
      userId: args.userId,
      sandboxId: args.sandboxId,
      ttydUrl: args.ttydUrl,
      skill: args.skill,
      cliProvider: args.cliProvider,
      status: "active",
      createdAt: now,
      expiresAt: now + SESSION_DURATION_MS,
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
    const now = Date.now();

    // Find expired active sandboxes
    const expired = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .collect();

    for (const sandbox of expired) {
      // Archive
      await ctx.db.patch(sandbox._id, {
        status: "archived",
        archivedAt: now,
      });

      // Stop Vercel sandbox
      await ctx.scheduler.runAfter(0, internal.sandboxes.stopVercelSandbox, {
        sandboxId: sandbox.sandboxId,
      });
    }

    return { expiredCount: expired.length };
  },
});

// =============================================================================
// Internal Actions (for calling external APIs)
// =============================================================================

/**
 * Stop the Vercel sandbox via API
 */
export const stopVercelSandbox = internalAction({
  args: { sandboxId: v.string() },
  handler: async (_ctx, args) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    try {
      await fetch(`${baseUrl}/api/sandbox/internal`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.CONVEX_INTERNAL_SECRET || "",
        },
        body: JSON.stringify({ sandboxId: args.sandboxId }),
      });
    } catch (error) {
      console.error("Failed to stop Vercel sandbox:", error);
    }
  },
});
