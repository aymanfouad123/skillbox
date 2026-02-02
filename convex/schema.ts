import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Active and archived sandboxes
  // Records are only created when sandbox is fully ready (no placeholder data)
  sandboxes: defineTable({
    userId: v.string(),
    sandboxId: v.string(), // Real Vercel sandbox ID (required)
    ttydUrl: v.string(), // Real terminal URL (required)
    skill: v.string(), // "owner/repo/skillName"
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    status: v.union(
      v.literal("active"), // Currently running
      v.literal("archived") // Stopped, kept for analytics
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    archivedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_userId", ["userId"])
    .index("by_sandboxId", ["sandboxId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Queue for waiting users when at capacity
  // Entries are DELETED when processed (not archived)
  queue: defineTable({
    userId: v.string(),
    position: v.number(),
    skill: v.string(), // "owner/repo/skillName"
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    createdAt: v.number(),
    retryCount: v.optional(v.number()), // Track failed attempts for retry logic
    // Heartbeat fields for Claude users (BYOK - need to detect browser close)
    lastHeartbeat: v.optional(v.number()), // Last heartbeat timestamp
    queueExpiresAt: v.optional(v.number()), // Stateless expiry: lastHeartbeat + 30s
    readyToFulfillAt: v.optional(v.number()), // When Claude user reached position 1 with capacity
  })
    .index("by_position", ["position"])
    .index("by_userId", ["userId"])
    .index("by_queueExpiresAt", ["queueExpiresAt"]),

  // Simple analytics counter (singleton-ish, one record)
  // The hero metric: total sandboxes created
  analytics: defineTable({
    totalSandboxes: v.number(), // Main metric for landing page
    opencodeCount: v.number(), // OpenCode CLI usage
    claudeCount: v.number(), // Claude CLI usage
    updatedAt: v.number(),
  }),
});
