import { v } from "convex/values";
import { query, internalMutation } from "./_generated/server";

// =============================================================================
// Public Queries
// =============================================================================

/**
 * Get total sandbox count (hero metric for landing page)
 */
export const getTotalSandboxes = query({
  args: {},
  handler: async (ctx) => {
    const analytics = await ctx.db.query("analytics").first();
    return analytics?.totalSandboxes ?? 0;
  },
});

/**
 * Get full analytics stats
 */
export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const analytics = await ctx.db.query("analytics").first();

    if (!analytics) {
      return {
        totalSandboxes: 0,
        opencodeCount: 0,
        claudeCount: 0,
      };
    }

    return {
      totalSandboxes: analytics.totalSandboxes,
      opencodeCount: analytics.opencodeCount,
      claudeCount: analytics.claudeCount,
    };
  },
});

/**
 * Get current real-time stats (active sandboxes, queue length, etc.)
 */
export const getCurrentStats = query({
  args: {},
  handler: async (ctx) => {
    // Active sandboxes
    const active = await ctx.db
      .query("sandboxes")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    // Queue length
    const queue = await ctx.db.query("queue").collect();

    // Total from analytics
    const analytics = await ctx.db.query("analytics").first();

    return {
      activeSandboxes: active.length,
      queueLength: queue.length,
      totalSandboxes: analytics?.totalSandboxes ?? 0,
    };
  },
});

// =============================================================================
// Internal Mutations
// =============================================================================

/**
 * Increment sandbox count (called when sandbox is created)
 */
export const incrementSandboxCount = internalMutation({
  args: {
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
  },
  handler: async (ctx, args) => {
    const analytics = await ctx.db.query("analytics").first();
    const now = Date.now();

    if (!analytics) {
      // Create initial record
      await ctx.db.insert("analytics", {
        totalSandboxes: 1,
        opencodeCount: args.cliProvider === "opencode" ? 1 : 0,
        claudeCount: args.cliProvider === "claude" ? 1 : 0,
        updatedAt: now,
      });
    } else {
      // Update existing
      await ctx.db.patch(analytics._id, {
        totalSandboxes: analytics.totalSandboxes + 1,
        opencodeCount:
          analytics.opencodeCount + (args.cliProvider === "opencode" ? 1 : 0),
        claudeCount:
          analytics.claudeCount + (args.cliProvider === "claude" ? 1 : 0),
        updatedAt: now,
      });
    }
  },
});
