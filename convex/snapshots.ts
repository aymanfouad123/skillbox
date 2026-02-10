import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  SNAPSHOT_EXPIRATION_MS,
  SNAPSHOT_RENEWAL_THRESHOLD_MS,
  SNAPSHOT_RENEWAL_RETRY_MS,
  OPENCODE_SNAPSHOT_SETUP_VERSION,
} from "./constants";

// Type assertion for internal API (types regenerated on `npx convex dev`)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internalApi = internal as any;

// Initial snapshots from skills.ts - used to seed the database
const INITIAL_SNAPSHOTS = [
  {
    playgroundId: "commerce",
    snapshotId: "snap_MSM5TBMfON2YDAAlhQAsPVzwxoZQ",
    sourceOwner: "vercel",
    sourceRepo: "commerce",
  },
  {
    playgroundId: "chat",
    snapshotId: "snap_VIHxRqZ1BSDvqnDng3Vxx1WiDbuC",
    sourceOwner: "vercel",
    sourceRepo: "ai-chatbot",
  },
  {
    playgroundId: "new-nextjs",
    snapshotId: "snap_O7CKp1m8HYW9iXF6WV5vSB6jOENT",
    sourceOwner: "create",
    sourceRepo: "nextjs",
  },
];

// =============================================================================
// Queries
// =============================================================================

/**
 * Get the active snapshot for a playground (any flavor)
 */
export const getSnapshot = query({
  args: { playgroundId: v.string() },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    return snapshot;
  },
});

/**
 * Get a compatible prebaked snapshot for boot (playground + flavor + setupVersion).
 * Used to skip OpenCode install when a matching snapshot exists.
 */
export const getCompatibleSnapshot = query({
  args: {
    playgroundId: v.string(),
    flavor: v.union(v.literal("opencode")),
    setupVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playground_flavor_status", (q) =>
        q
          .eq("playgroundId", args.playgroundId)
          .eq("flavor", args.flavor)
          .eq("status", "active")
      )
      .first();

    if (
      !snapshot ||
      snapshot.setupVersion === undefined ||
      snapshot.setupVersion !== args.setupVersion
    ) {
      return null;
    }
    return snapshot;
  },
});

/**
 * Get all active snapshots
 */
export const getAllSnapshots = query({
  args: {},
  handler: async (ctx) => {
    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    return snapshots;
  },
});

/**
 * Get snapshots that are expiring soon (within threshold)
 */
export const getExpiringSnapshots = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const threshold = now + SNAPSHOT_RENEWAL_THRESHOLD_MS;

    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .filter((q) => q.lt(q.field("expiresAt"), threshold))
      .collect();

    return snapshots;
  },
});

// =============================================================================
// Mutations
// =============================================================================

/**
 * Register a new snapshot (called after creating a snapshot via SDK)
 */
export const registerSnapshot = mutation({
  args: {
    playgroundId: v.string(),
    snapshotId: v.string(),
    sourceOwner: v.string(),
    sourceRepo: v.string(),
    flavor: v.optional(v.union(v.literal("opencode"))),
    setupVersion: v.optional(v.number()),
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Mark any existing snapshots for this playground as expired
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();

    for (const snapshot of existing) {
      await ctx.db.patch(snapshot._id, { status: "expired" });
    }

    // Create new snapshot record
    await ctx.db.insert("snapshots", {
      playgroundId: args.playgroundId,
      snapshotId: args.snapshotId,
      createdAt: now,
      expiresAt: now + SNAPSHOT_EXPIRATION_MS,
      status: "active",
      sourceOwner: args.sourceOwner,
      sourceRepo: args.sourceRepo,
      ...(args.flavor !== undefined && { flavor: args.flavor }),
      ...(args.setupVersion !== undefined && { setupVersion: args.setupVersion }),
      ...(args.capabilities !== undefined && { capabilities: args.capabilities }),
    });

    return { success: true };
  },
});

/**
 * Register or update a snapshot from ad-hoc renewal (boot-time failure).
 * Similar to registerSnapshot but updates if already renewing (deduplication).
 */
export const registerOrUpdateSnapshot = mutation({
  args: {
    playgroundId: v.string(),
    snapshotId: v.string(),
    sourceOwner: v.string(),
    sourceRepo: v.string(),
    flavor: v.optional(v.union(v.literal("opencode"))),
    setupVersion: v.optional(v.number()),
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Mark any existing snapshots for this playground as expired
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .collect();

    for (const snapshot of existing) {
      await ctx.db.patch(snapshot._id, { status: "expired" });
    }

    // Create new snapshot record
    await ctx.db.insert("snapshots", {
      playgroundId: args.playgroundId,
      snapshotId: args.snapshotId,
      createdAt: now,
      expiresAt: now + SNAPSHOT_EXPIRATION_MS,
      status: "active",
      sourceOwner: args.sourceOwner,
      sourceRepo: args.sourceRepo,
      ...(args.flavor !== undefined && { flavor: args.flavor }),
      ...(args.setupVersion !== undefined && { setupVersion: args.setupVersion }),
      ...(args.capabilities !== undefined && { capabilities: args.capabilities }),
    });

    return { success: true };
  },
});

/**
 * Check if a snapshot is currently renewing (for deduplication).
 */
export const isSnapshotRenewing = query({
  args: { playgroundId: v.string() },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "renewing"))
      .first();

    return { renewing: !!snapshot };
  },
});

/**
 * Seed initial snapshots from hardcoded values
 * Call this once to initialize the database with existing snapshots
 */
export const seedInitialSnapshots = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let seeded = 0;

    for (const snapshot of INITIAL_SNAPSHOTS) {
      // Check if already exists
      const existing = await ctx.db
        .query("snapshots")
        .withIndex("by_playgroundId", (q) =>
          q.eq("playgroundId", snapshot.playgroundId)
        )
        .first();

      if (!existing) {
        await ctx.db.insert("snapshots", {
          playgroundId: snapshot.playgroundId,
          snapshotId: snapshot.snapshotId,
          createdAt: now,
          // Set expiration to 5 days from now (gives time before renewal needed)
          expiresAt: now + 5 * 24 * 60 * 60 * 1000,
          status: "active",
          sourceOwner: snapshot.sourceOwner,
          sourceRepo: snapshot.sourceRepo,
        });
        seeded++;
      }
    }

    return { success: true, seeded };
  },
});

// =============================================================================
// Internal Mutations
// =============================================================================

/**
 * Mark a snapshot as renewing (called before starting renewal).
 * Public version for ad-hoc renewal deduplication.
 */
export const markSnapshotRenewing = mutation({
  args: { playgroundId: v.string() },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (snapshot) {
      await ctx.db.patch(snapshot._id, { status: "renewing" });
    }
  },
});

/**
 * Internal version for cron-based renewal
 */
export const markSnapshotRenewingInternal = internalMutation({
  args: { playgroundId: v.string() },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();

    if (snapshot) {
      await ctx.db.patch(snapshot._id, { status: "renewing" });
    }
  },
});

/**
 * Revert snapshot from renewing back to active (on renewal failure).
 * Public version for ad-hoc renewal error handling.
 */
export const revertSnapshotRenewingToActive = mutation({
  args: {
    playgroundId: v.string(),
    lastRenewalError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "renewing"))
      .first();

    if (snapshot) {
      await ctx.db.patch(snapshot._id, {
        status: "active",
        ...(args.lastRenewalError !== undefined && {
          lastRenewalError: args.lastRenewalError,
        }),
      });
    }
  },
});

/**
 * Internal version for cron-based renewal
 */
export const revertSnapshotRenewingToActiveInternal = internalMutation({
  args: {
    playgroundId: v.string(),
    lastRenewalError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .filter((q) => q.eq(q.field("status"), "renewing"))
      .first();

    if (snapshot) {
      await ctx.db.patch(snapshot._id, {
        status: "active",
        ...(args.lastRenewalError !== undefined && {
          lastRenewalError: args.lastRenewalError,
        }),
      });
    }
  },
});

/**
 * Update snapshot after renewal (stores metadata from renew API)
 */
export const updateSnapshotAfterRenewal = internalMutation({
  args: {
    playgroundId: v.string(),
    newSnapshotId: v.string(),
    flavor: v.optional(v.union(v.literal("opencode"))),
    setupVersion: v.optional(v.number()),
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Mark old snapshot as expired
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_playgroundId", (q) =>
        q.eq("playgroundId", args.playgroundId)
      )
      .collect();

    for (const snapshot of existing) {
      await ctx.db.patch(snapshot._id, { status: "expired" });
    }

    // Get source info from any existing snapshot
    const oldSnapshot = existing[0];
    if (!oldSnapshot) {
      console.error(`No existing snapshot for ${args.playgroundId}`);
      return;
    }

    // Create new snapshot record with optional compatibility metadata
    await ctx.db.insert("snapshots", {
      playgroundId: args.playgroundId,
      snapshotId: args.newSnapshotId,
      createdAt: now,
      expiresAt: now + SNAPSHOT_EXPIRATION_MS,
      status: "active",
      sourceOwner: oldSnapshot.sourceOwner,
      sourceRepo: oldSnapshot.sourceRepo,
      ...(args.flavor !== undefined && { flavor: args.flavor }),
      ...(args.setupVersion !== undefined && { setupVersion: args.setupVersion }),
      ...(args.capabilities !== undefined && {
        capabilities: args.capabilities,
      }),
    });
  },
});

/**
 * Check and renew expiring snapshots (called by cron)
 */
export const checkAndRenewSnapshots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const threshold = now + SNAPSHOT_RENEWAL_THRESHOLD_MS;

    const expiring = await ctx.db
      .query("snapshots")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .filter((q) => q.lt(q.field("expiresAt"), threshold))
      .collect();

    // Schedule renewal for each expiring snapshot
    for (const snapshot of expiring) {
      // Mark as renewing to prevent duplicate renewals
      await ctx.db.patch(snapshot._id, { status: "renewing" });

      // Schedule the renewal action (uses internal mutations for auth)
      await ctx.scheduler.runAfter(0, internalApi.snapshots.renewSnapshot, {
        playgroundId: snapshot.playgroundId,
        sourceOwner: snapshot.sourceOwner,
        sourceRepo: snapshot.sourceRepo,
      });
    }

    return { count: expiring.length };
  },
});

// =============================================================================
// Internal Actions
// =============================================================================

/**
 * Renew a snapshot by creating a new one
 * This recreates the environment from scratch
 * On failure: revert to active and schedule retry
 */
export const renewSnapshot = internalAction({
  args: {
    playgroundId: v.string(),
    sourceOwner: v.string(),
    sourceRepo: v.string(),
  },
  handler: async (ctx, args) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    try {
      console.log(`Renewing snapshot for ${args.playgroundId}...`);

      const response = await fetch(`${baseUrl}/api/snapshots/renew`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.CONVEX_INTERNAL_SECRET || "",
        },
        body: JSON.stringify({
          playgroundId: args.playgroundId,
          sourceOwner: args.sourceOwner,
          sourceRepo: args.sourceRepo,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const errMsg =
          typeof errorBody?.error === "string"
            ? errorBody.error
            : `HTTP ${response.status}`;
        console.error(
          `Failed to renew snapshot for ${args.playgroundId}:`,
          errorBody
        );
        await ctx.runMutation(internalApi.snapshots.revertSnapshotRenewingToActiveInternal, {
          playgroundId: args.playgroundId,
          lastRenewalError: errMsg,
        });
        await ctx.scheduler.runAfter(
          SNAPSHOT_RENEWAL_RETRY_MS,
          internalApi.snapshots.renewSnapshot,
          args
        );
        return;
      }

      const data = await response.json();
      console.log(
        `Snapshot renewed for ${args.playgroundId}: ${data.snapshotId}`
      );

      await ctx.runMutation(internalApi.snapshots.updateSnapshotAfterRenewal, {
        playgroundId: args.playgroundId,
        newSnapshotId: data.snapshotId,
        flavor: data.flavor ?? undefined,
        setupVersion: data.setupVersion ?? undefined,
        capabilities: data.capabilities ?? undefined,
      });
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      console.error(`Error renewing snapshot for ${args.playgroundId}:`, error);
      await ctx.runMutation(internalApi.snapshots.revertSnapshotRenewingToActiveInternal, {
        playgroundId: args.playgroundId,
        lastRenewalError: errMsg,
      });
      await ctx.scheduler.runAfter(
        SNAPSHOT_RENEWAL_RETRY_MS,
        internalApi.snapshots.renewSnapshot,
        args
      );
    }
  },
});
