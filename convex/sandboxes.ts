import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  MAX_SANDBOXES,
  HEARTBEAT_TIMEOUT_MS,
  SESSION_DURATION_MS,
  EXTEND_TIMEOUT_MS,
} from "./constants";

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

    if (queueEntry) {
      // Count position
      const ahead = await ctx.db
        .query("queue")
        .withIndex("by_position")
        .filter((q) => q.lt(q.field("position"), queueEntry.position))
        .collect();

      const position = ahead.length + 1;

      // For Claude users at position 1, check if capacity is available
      // Frontend will handle sandbox creation with API key from localStorage
      let readyToFulfill = false;
      if (queueEntry.cliProvider === "claude" && position === 1) {
        const activeCount = await ctx.db
          .query("sandboxes")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .collect();
        readyToFulfill = activeCount.length < MAX_SANDBOXES;
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
    // Vercel timing from SDK for accurate countdown
    vercelCreatedAt: v.optional(v.number()),
    vercelTimeout: v.optional(v.number()),
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

    // Calculate expiration based on Vercel timing if available
    // This accounts for setup time that already elapsed
    let expiresAt = now + SESSION_DURATION_MS;
    if (args.vercelCreatedAt && args.vercelTimeout) {
      // Vercel sandbox will expire at: vercelCreatedAt + vercelTimeout
      // Use that as our expiration, minus a small buffer for cleanup
      const vercelExpiresAt = args.vercelCreatedAt + args.vercelTimeout;
      expiresAt = Math.min(expiresAt, vercelExpiresAt - 30000); // 30s buffer
    }

    // Create the sandbox record with complete data
    await ctx.db.insert("sandboxes", {
      userId: args.userId,
      sandboxId: args.sandboxId,
      ttydUrl: args.ttydUrl,
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
 * Send heartbeat for Claude users in queue
 * Called every 10 seconds by frontend to prove browser is still connected
 */
export const sendHeartbeat = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
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
    // Find the queue entry
    const entry = await ctx.db
      .query("queue")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!entry) {
      return { success: false, error: "not_in_queue" };
    }

    // Verify they're at position 1
    const ahead = await ctx.db
      .query("queue")
      .withIndex("by_position")
      .filter((q) => q.lt(q.field("position"), entry.position))
      .collect();

    if (ahead.length > 0) {
      return { success: false, error: "not_first_in_queue" };
    }

    // Verify capacity is available
    const activeCount = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    if (activeCount.length >= MAX_SANDBOXES) {
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
 * Extends both Convex expiration and Vercel sandbox timeout
 */
export const extendTimeout = mutation({
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

    // Check if already extended
    if (sandbox.hasExtendedTimeout) {
      return { success: false, error: "already_extended" };
    }

    // Update Convex expiration
    const newExpiresAt = sandbox.expiresAt + EXTEND_TIMEOUT_MS;
    await ctx.db.patch(sandbox._id, {
      expiresAt: newExpiresAt,
      hasExtendedTimeout: true,
    });

    // Schedule Vercel sandbox extension
    await ctx.scheduler.runAfter(0, internal.sandboxes.extendVercelSandbox, {
      sandboxId: sandbox.sandboxId,
      duration: EXTEND_TIMEOUT_MS,
    });

    return { success: true, newExpiresAt };
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

    // Create sandbox
    await ctx.db.insert("sandboxes", {
      userId: args.userId,
      sandboxId: args.sandboxId,
      ttydUrl: args.ttydUrl,
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

/**
 * Extend the Vercel sandbox timeout via API
 */
export const extendVercelSandbox = internalAction({
  args: { sandboxId: v.string(), duration: v.number() },
  handler: async (_ctx, args) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    try {
      const response = await fetch(`${baseUrl}/api/sandbox/internal`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.CONVEX_INTERNAL_SECRET || "",
        },
        body: JSON.stringify({
          sandboxId: args.sandboxId,
          action: "extend",
          duration: args.duration,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error("Failed to extend sandbox:", error);
      }
    } catch (error) {
      console.error("Failed to extend Vercel sandbox:", error);
    }
  },
});
