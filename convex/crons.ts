import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Clean up expired sandboxes every minute
// Archives sandboxes that have exceeded their session time
crons.interval(
  "cleanup expired sandboxes",
  { minutes: 1 },
  internal.sandboxes.cleanupExpiredSandboxes
);

// Process the queue every 30 seconds
// Creates sandboxes for waiting users when slots become available
crons.interval(
  "process sandbox queue",
  { seconds: 30 },
  internal.queue.processQueue
);

// Clean up stale Claude queue entries every 15 seconds
// Removes entries where heartbeat has expired (browser closed)
crons.interval(
  "cleanup stale claude queue",
  { seconds: 15 },
  internal.queue.cleanupStaleClaudeEntries
);

// Handle slow Claude users every 10 seconds
// Kicks users who are ready but haven't booted within 15 seconds to back of line
crons.interval(
  "handle slow claude users",
  { seconds: 10 },
  internal.queue.handleSlowClaudeUsers
);

export default crons;
