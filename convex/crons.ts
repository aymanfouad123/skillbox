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

export default crons;
