import { v } from "convex/values";
import { query, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Maximum number of concurrent sandboxes
const MAX_SANDBOXES = 100;

// Maximum retry attempts before giving up
const MAX_RETRIES = 2;

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

    for (const entry of waiting) {
      // Schedule sandbox creation
      await ctx.scheduler.runAfter(0, internal.queue.createSandboxFromQueue, {
        queueId: entry._id,
        userId: entry.userId,
        skill: entry.skill,
        cliProvider: entry.cliProvider,
        retryCount: entry.retryCount ?? 0,
      });
    }

    return { processed: waiting.length };
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
