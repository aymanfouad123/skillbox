import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Active and archived sandboxes
  // Records are only created when sandbox is fully ready (no placeholder data)
  sandboxes: defineTable({
    userId: v.string(),
    sandboxId: v.string(), // Real Vercel sandbox ID (required)
    ttydUrl: v.string(), // Real terminal URL (required)
    previewUrl: v.optional(v.string()), // Public dev-server URL (only set if ready)
    skill: v.string(), // "owner/repo/skillName"
    cliProvider: v.union(v.literal("opencode"), v.literal("claude")),
    status: v.union(
      v.literal("active"), // Currently running
      v.literal("archived") // Stopped, kept for analytics
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    archivedAt: v.optional(v.number()),
    // Track Vercel sandbox timing for accurate countdown
    vercelCreatedAt: v.optional(v.number()), // When Vercel sandbox was created
    vercelTimeout: v.optional(v.number()), // Initial timeout in ms from Vercel
    // Extension tracking (one-time only)
    hasExtendedTimeout: v.optional(v.boolean()),
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
    // Reserve entry so same slot isn't processed twice (cron runs before action completes)
    processingStartedAt: v.optional(v.number()),
    // Heartbeat fields for Claude users (BYOK - need to detect browser close)
    lastHeartbeat: v.optional(v.number()), // Last heartbeat timestamp
    queueExpiresAt: v.optional(v.number()), // Stateless expiry: lastHeartbeat + 30s
    readyToFulfillAt: v.optional(v.number()), // When Claude user reached position 1 with capacity
  })
    .index("by_position", ["position"])
    .index("by_userId", ["userId"])
    .index("by_queueExpiresAt", ["queueExpiresAt"])
    .index("by_cliProvider_queueExpiresAt", ["cliProvider", "queueExpiresAt"]),

  // Simple analytics counter (singleton-ish, one record)
  // The hero metric: total sandboxes created
  analytics: defineTable({
    totalSandboxes: v.number(), // Main metric for landing page
    opencodeCount: v.number(), // OpenCode CLI usage
    claudeCount: v.number(), // Claude CLI usage
    updatedAt: v.number(),
  }),

  // Playground snapshots for fast sandbox boot
  // Snapshots expire after 7 days per Vercel SDK
  snapshots: defineTable({
    playgroundId: v.string(), // "commerce", "chat", "new-nextjs"
    snapshotId: v.string(), // Vercel snapshot ID (snap_xxx)
    createdAt: v.number(),
    expiresAt: v.number(), // 7 days from creation
    status: v.union(
      v.literal("active"), // Currently in use
      v.literal("expired"), // Past expiration
      v.literal("renewing") // Being renewed
    ),
    // Metadata for recreation
    sourceOwner: v.string(), // GitHub owner or "create" for fresh
    sourceRepo: v.string(), // GitHub repo or "nextjs" for fresh
    // Compatibility: what is prebaked (enables skip-install at boot)
    flavor: v.optional(v.union(v.literal("opencode"))), // more flavors later
    setupVersion: v.optional(v.number()), // e.g. OPENCODE_SNAPSHOT_SETUP_VERSION
    capabilities: v.optional(v.array(v.string())), // e.g. ["opencode_cli", "opencode_config"]
    lastRenewalError: v.optional(v.string()), // observability when renewal failed
  })
    .index("by_playgroundId", ["playgroundId"])
    .index("by_status", ["status"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_playground_flavor_status", ["playgroundId", "flavor", "status"]),
});
