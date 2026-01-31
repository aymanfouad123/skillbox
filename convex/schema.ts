import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Tracks active sandboxes
  sandboxes: defineTable({
    sandboxId: v.string(), // Vercel sandbox ID
    userId: v.string(), // Browser session ID
    ttydUrl: v.optional(v.string()), // Terminal URL (set when ready)
    status: v.union(
      v.literal("creating"),
      v.literal("ready"),
      v.literal("stopping"),
      v.literal("stopped"),
    ),
    // Request data for creating the sandbox
    requestData: v.object({
      skillOwner: v.string(),
      skillRepo: v.string(),
      skillName: v.string(),
      targetOwner: v.string(),
      targetRepo: v.string(),
      cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    }),
    createdAt: v.number(), // Timestamp
    expiresAt: v.number(), // Timestamp when sandbox should be cleaned up
  })
    .index("by_status", ["status"])
    .index("by_userId", ["userId"])
    .index("by_sandboxId", ["sandboxId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Queue for waiting users when at capacity
  queue: defineTable({
    userId: v.string(), // Browser session ID
    position: v.number(), // Queue position
    requestData: v.object({
      skillOwner: v.string(),
      skillRepo: v.string(),
      skillName: v.string(),
      targetOwner: v.string(),
      targetRepo: v.string(),
      cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
      // API key is NOT stored in Convex for security - passed directly when processing
    }),
    status: v.union(
      v.literal("waiting"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_status_position", ["status", "position"])
    .index("by_userId", ["userId"])
    .index("by_position", ["position"]),
});
