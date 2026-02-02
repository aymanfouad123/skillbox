/**
 * Single source of truth for queue and sandbox capacity/timeouts.
 * Import in convex/queue.ts and convex/sandboxes.ts to avoid drift.
 */

// Maximum number of concurrent sandboxes
export const MAX_SANDBOXES = 150;

// Maximum retry attempts before removing a queue entry
export const MAX_RETRIES = 2;

// Heartbeat timeout for Claude users in queue (30 seconds)
export const HEARTBEAT_TIMEOUT_MS = 30 * 1000;

// Claude fulfillment timeout - if ready but no boot within 15s, kick to back
export const CLAUDE_FULFILL_TIMEOUT_MS = 15 * 1000;

// If sandbox creation from queue doesn't complete within this time, entry is re-eligible
export const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

// Sandbox session duration in milliseconds (6 minutes)
export const SESSION_DURATION_MS = 6 * 60 * 1000;
