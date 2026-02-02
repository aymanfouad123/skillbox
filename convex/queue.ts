import { v } from "convex/values";
import { query, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Maximum number of concurrent sandboxes
const MAX_SANDBOXES = 150;

// Maximum retry attempts before giving up
const MAX_RETRIES = 2;

// Claude fulfillment timeout - if ready but no boot within 15s, kick to back
const CLAUDE_FULFILL_TIMEOUT_MS = 15 * 1000;

// =============================================================================
// Queries
// =============================================================================

/**
 * Get queue length
 */
export const getQueueLength = query({
  args: {},
  handler: async (ctx) => {
    const queue = await ctx.db.query("queue").collect();
    return queue.length;
  },
});

// =============================================================================
// Internal Mutations
// =============================================================================

/**
 * Process queue - create sandboxes for waiting users when slots available
 * NOTE: Claude entries are handled client-side (BYOK - API key in localStorage)
 */
export const processQueue = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Count active sandboxes
    const active = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    const availableSlots = MAX_SANDBOXES - active.length;
    if (availableSlots <= 0) {
      return { processed: 0 };
    }

    // Get next entries by position (FIFO)
    const waiting = await ctx.db
      .query("queue")
      .withIndex("by_position")
      .order("asc")
      .take(availableSlots);

    let processed = 0;
    const now = Date.now();

    for (const entry of waiting) {
      // Skip Claude entries - they're handled client-side via claimQueueSlot
      // because API keys are stored in browser localStorage (BYOK security)
      if (entry.cliProvider === "claude") {
        // Mark when Claude user became ready to fulfill (if not already set)
        if (!entry.readyToFulfillAt) {
          await ctx.db.patch(entry._id, { readyToFulfillAt: now });
        }
        continue;
      }

      // Schedule sandbox creation for OpenCode entries
      await ctx.scheduler.runAfter(0, internal.queue.createSandboxFromQueue, {
        queueId: entry._id,
        userId: entry.userId,
        skill: entry.skill,
        cliProvider: entry.cliProvider,
        retryCount: entry.retryCount ?? 0,
      });
      processed++;
    }

    return { processed };
  },
});

/**
 * Increment retry count or delete queue entry if max retries exceeded
 */
export const handleQueueFailure = internalMutation({
  args: {
    queueId: v.id("queue"),
    currentRetryCount: v.number(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.queueId);
    if (!entry) return;

    if (args.currentRetryCount >= MAX_RETRIES) {
      // Max retries exceeded, remove from queue
      console.log(
        `Queue entry ${args.queueId} exceeded max retries, removing`
      );
      await ctx.db.delete(args.queueId);
    } else {
      // Increment retry count, will be picked up on next queue processing
      await ctx.db.patch(args.queueId, {
        retryCount: args.currentRetryCount + 1,
      });
      console.log(
        `Queue entry ${args.queueId} retry count: ${args.currentRetryCount + 1}`
      );
    }
  },
});

/**
 * Clean up stale Claude queue entries (browser closed/disconnected)
 * Uses stateless expiry: if queueExpiresAt < now, remove the entry
 */
export const cleanupStaleClaudeEntries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Find Claude entries with expired heartbeats
    const allQueue = await ctx.db.query("queue").collect();
    const staleEntries = allQueue.filter(
      (entry) =>
        entry.cliProvider === "claude" &&
        entry.queueExpiresAt &&
        entry.queueExpiresAt < now
    );

    let removed = 0;
    for (const entry of staleEntries) {
      console.log(
        `Removing stale Claude queue entry for user ${entry.userId} (heartbeat expired)`
      );
      await ctx.db.delete(entry._id);
      removed++;
    }

    return { checked: allQueue.length, removed };
  },
});

/**
 * Handle slow Claude users at position 1
 * If a Claude user is ready to fulfill but hasn't booted within 15s, kick them to back of line
 */
export const handleSlowClaudeUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Get Claude entries at position 1 that have been ready too long
    const queue = await ctx.db
      .query("queue")
      .withIndex("by_position")
      .order("asc")
      .collect();

    // Find first Claude entry that's at position 1
    const firstEntry = queue[0];
    if (!firstEntry) return { kicked: 0 };
    if (firstEntry.cliProvider !== "claude") return { kicked: 0 };
    if (!firstEntry.readyToFulfillAt) return { kicked: 0 };

    // Check if they've exceeded the fulfillment timeout
    const readyDuration = now - firstEntry.readyToFulfillAt;
    if (readyDuration < CLAUDE_FULFILL_TIMEOUT_MS) {
      return { kicked: 0 };
    }

    // Kick to back of line: delete and re-add with new position
    console.log(
      `Kicking slow Claude user ${firstEntry.userId} to back of queue (ready for ${Math.round(readyDuration / 1000)}s)`
    );

    // Get new position (back of line)
    const lastInQueue = await ctx.db
      .query("queue")
      .withIndex("by_position")
      .order("desc")
      .first();

    const newPosition = lastInQueue ? lastInQueue.position + 1 : 1;

    // Update the entry: reset position and readyToFulfillAt, refresh heartbeat
    await ctx.db.patch(firstEntry._id, {
      position: newPosition,
      readyToFulfillAt: undefined,
      lastHeartbeat: now,
      queueExpiresAt: now + 30 * 1000, // Reset heartbeat timeout
    });

    return { kicked: 1 };
  },
});

// =============================================================================
// Internal Actions
// =============================================================================

/**
 * Create sandbox for queued user
 */
export const createSandboxFromQueue = internalAction({
  args: {
    queueId: v.id("queue"),
    userId: v.string(),
    skill: v.string(),
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    retryCount: v.number(),
  },
  handler: async (ctx, args) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    // Parse skill string "owner/repo/skillName"
    const skillParts = args.skill.split("/");
    if (skillParts.length < 3) {
      console.error("Invalid skill format:", args.skill);
      await ctx.runMutation(internal.sandboxes.deleteQueueEntry, {
        queueId: args.queueId,
      });
      return;
    }

    const skillOwner = skillParts[0];
    const skillRepo = skillParts[1];
    const skillName = skillParts.slice(2).join("/");

    // Validate skill parts are not empty
    if (!skillOwner || !skillRepo || !skillName) {
      console.error("Empty skill component in:", args.skill);
      await ctx.runMutation(internal.sandboxes.deleteQueueEntry, {
        queueId: args.queueId,
      });
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/api/sandbox/internal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.CONVEX_INTERNAL_SECRET || "",
        },
        body: JSON.stringify({
          skillOwner,
          skillRepo,
          skillName,
          // For queue processing, we use fresh Next.js as target
          // (API key not stored for security, so Claude CLI won't work from queue)
          targetOwner: "fresh",
          targetRepo: "nextjs",
          cliProvider: args.cliProvider,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create sandbox");
      }

      const data = await response.json();

      // Register sandbox and delete queue entry
      await ctx.runMutation(internal.sandboxes.registerSandboxInternal, {
        queueId: args.queueId,
        userId: args.userId,
        sandboxId: data.sandboxId,
        ttydUrl: data.ttydUrl,
        skill: args.skill,
        cliProvider: args.cliProvider,
      });
    } catch (error) {
      console.error("Failed to create sandbox from queue:", error);

      // Use retry logic instead of immediately deleting
      await ctx.runMutation(internal.queue.handleQueueFailure, {
        queueId: args.queueId,
        currentRetryCount: args.retryCount,
      });
    }
  },
});
