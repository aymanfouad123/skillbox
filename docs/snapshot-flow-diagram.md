# Snapshot System Flow Diagrams

## 1. Complete System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                         SNAPSHOT SYSTEM                                 │
│                                                                         │
│  ┌──────────────┐       ┌──────────────┐       ┌──────────────┐      │
│  │   STORAGE    │       │  RENEWAL     │       │    BOOT      │      │
│  │  (Convex DB) │◄──────┤   SYSTEM     ├──────►│    SYSTEM    │      │
│  │              │       │              │       │              │      │
│  │ • snapshots  │       │ • Cron       │       │ • Query      │      │
│  │   table      │       │ • Ad-hoc     │       │ • Create     │      │
│  │              │       │ • Renew API  │       │ • Skip CLI   │      │
│  └──────────────┘       └──────────────┘       └──────────────┘      │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Cron Renewal Flow (Scheduled, Proactive)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CRON RENEWAL PATH                             │
│                  (Daily check, 2-day expiration buffer)              │
└─────────────────────────────────────────────────────────────────────┘

  ⏰ Every 24 hours
       │
       ▼
  ┌──────────────────────────────────────┐
  │ checkAndRenewSnapshots               │
  │ Query: expiresAt < now + 2 days      │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ For each expiring snapshot:          │
  │ 1. Mark as "renewing" (lock)         │
  │ 2. Schedule renewSnapshot action     │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ renewSnapshot (internal action)      │
  │ POST /api/snapshots/renew            │
  │ Headers: X-Internal-Secret           │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Renewal Endpoint:                    │
  │ 1. Create sandbox (git/create-next)  │
  │ 2. npm/pnpm install                  │
  │ 3. Install OpenCode CLI              │
  │ 4. Configure OpenCode                │
  │ 5. sandbox.snapshot()                │
  │    (captures state + stops sandbox)  │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Return:                              │
  │ {                                    │
  │   snapshotId: "snap_xxx",            │
  │   flavor: "opencode",                │
  │   setupVersion: 1,                   │
  │   capabilities: [...]                │
  │ }                                    │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ updateSnapshotAfterRenewal           │
  │ 1. Mark old snapshot "expired"       │
  │ 2. Insert new snapshot:              │
  │    - status: "active"                │
  │    - expiresAt: now + 7 days         │
  │    - flavor: "opencode"              │
  │    - setupVersion: 1                 │
  └────────────┬─────────────────────────┘
               │
               ▼
         ✅ RENEWED
    (7 more days available)

┌─────────────────────────────────────────┐
│ ON FAILURE:                             │
│ 1. revertSnapshotRenewingToActive       │
│    - Mark as "active" again             │
│    - Store lastRenewalError             │
│ 2. Schedule retry after 1 hour          │
└─────────────────────────────────────────┘
```

---

## 3. Boot-Time Optimization Flow (User Request)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     BOOT-TIME OPTIMIZATION                           │
│              (Fast path: 30s vs slow path: 4min)                     │
└─────────────────────────────────────────────────────────────────────┘

  👤 User requests sandbox
       │
       ▼
  ┌──────────────────────────────────────┐
  │ POST /api/sandbox or                 │
  │      /api/sandbox/internal           │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Query Convex:                        │
  │ getCompatibleSnapshot({              │
  │   playgroundId: "commerce",          │
  │   flavor: "opencode",                │
  │   setupVersion: 1                    │
  │ })                                   │
  └────────────┬─────────────────────────┘
               │
         ┌─────┴─────┐
         │           │
    FOUND            NOT FOUND
         │           │
         ▼           ▼
  ┌─────────────┐  ┌─────────────┐
  │  FAST PATH  │  │  SLOW PATH  │
  └──────┬──────┘  └──────┬──────┘
         │                │
         ▼                ▼
  ┌──────────────────────────────────────┐
  │ Sandbox.create({                     │
  │   source: { type: "snapshot",        │────┐ FAST
  │             snapshotId: "snap_xxx" } │    │
  │ })                                   │    │
  └────────────┬─────────────────────────┘    │
               │                               │
               ▼                               │
  ┌──────────────────────────────────────┐    │
  │ Skip CLI install? (prebaked)         │    │
  │                                      │    │
  │ if (usedCompatibleSnapshot &&        │    │
  │     snapshotUsed) {                  │    │
  │   ✅ Skip installCLI()                │◄───┘
  │   ✅ Skip configSetup()               │
  │   console.log("Skipping OpenCode")   │
  │ } else {                             │
  │   ❌ Install CLI (slow)               │◄───┐ SLOW
  │   ❌ Configure CLI (slow)             │    │
  │ }                                    │    │
  └────────────┬─────────────────────────┘    │
               │                               │
               ▼                               │
  ┌──────────────────────────────────────┐    │
  │ Install TTYD                         │    │
  │ Inject skill                         │    │
  │ Launch terminal                      │    │
  │ Start dev server                     │    │
  └────────────┬─────────────────────────┘    │
               │                               │
               ▼                               │
         ✅ READY                               │
       (30s total)                            │
                                               │
  ┌──────────────────────────────────────┐    │
  │ Sandbox.create({                     │    │
  │   source: { type: "git",             │────┘
  │             url: "github.com/..." }  │
  │ })                                   │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ npm/pnpm install (2-3min)            │
  └────────────┬─────────────────────────┘
               │
               ▼
         ✅ READY
       (4min total)
```

---

## 4. Ad-Hoc Renewal Flow (Boot Failure Recovery)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      AD-HOC RENEWAL PATH                             │
│         (Boot-time failure triggers background renewal)              │
└─────────────────────────────────────────────────────────────────────┘

  👤 User requests sandbox
       │
       ▼
  ┌──────────────────────────────────────┐
  │ Try to boot from snapshotId          │
  │ Sandbox.create({                     │
  │   source: { type: "snapshot", ... }  │
  │ })                                   │
  └────────────┬─────────────────────────┘
               │
               ▼
         ❌ BOOT FAILED
    (snapshot expired/corrupted/API error)
               │
               ▼
  ┌──────────────────────────────────────┐
  │ if (snapshotId && !snapshotUsed) {   │
  │   triggerSnapshotRenewal(            │
  │     playgroundId, owner, repo        │
  │   ).catch(err => warn(...))          │  ◄── Fire-and-forget
  │ }                                    │      (don't block user)
  └────────────┬─────────────────────────┘
               │
         ┌─────┴─────┐
         │           │
    RENEWAL          USER
    (background)     (foreground)
         │           │
         ▼           ▼
  ┌──────────────┐  ┌──────────────┐
  │  RENEWAL     │  │  FALLBACK    │
  │  SYSTEM      │  │  TO GIT      │
  └──────┬───────┘  └──────┬───────┘
         │                 │
         ▼                 ▼
  ┌──────────────────────────────────────┐
  │ 1. isSnapshotRenewing?               │
  │    (deduplication check)             │
  │                                      │
  │    if renewing: skip (already locked)│
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ 2. markSnapshotRenewing              │
  │    (lock to prevent duplicates)      │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ 3. POST /api/snapshots/renew         │
  │    (same as cron renewal)            │
  └────────────┬─────────────────────────┘
               │
         ┌─────┴─────┐
         │           │
    SUCCESS          FAILURE
         │           │
         ▼           ▼
  ┌──────────────────────────────────────┐
  │ 4a. registerOrUpdateSnapshot         │
  │     - Expire old snapshots           │
  │     - Insert new snapshot:           │
  │       status: "active"               │
  │       snapshotId: "snap_new"         │
  │       flavor: "opencode"             │
  │       setupVersion: 1                │
  └────────────┬─────────────────────────┘
               │
               ▼
         ✅ RENEWED
    (future boots will be fast)

  ┌──────────────────────────────────────┐
  │ 4b. revertSnapshotRenewingToActive   │
  │     - Mark as "active" again         │
  │     - Store lastRenewalError         │
  └──────────────────────────────────────┘
               │
               ▼
         ❌ FAILED
    (old snapshot still active)

┌─────────────────────────────────────────┐
│ Meanwhile, user gets:                   │
│ Sandbox.create({                        │
│   source: { type: "git", ... }          │
│ })                                      │
│ + Full install (slow, but works)        │
│                                         │
│ Next user will get fast boot if         │
│ renewal succeeded!                      │
└─────────────────────────────────────────┘
```

---

## 5. Version Invalidation Flow (CLI Update)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    VERSION INVALIDATION                              │
│       (How we handle OpenCode CLI updates automatically)            │
└─────────────────────────────────────────────────────────────────────┘

  📦 OpenCode CLI updated (v1.0 → v1.1)
       │
       ▼
  ┌──────────────────────────────────────┐
  │ Developer action:                    │
  │ Edit convex/constants.ts:            │
  │                                      │
  │ export const                         │
  │   OPENCODE_SNAPSHOT_SETUP_VERSION    │
  │   = 2;  // was 1                     │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ All imports auto-update:             │
  │ - app/lib/sandbox-utils.ts           │
  │ - app/api/snapshots/renew/route.ts   │
  │ - convex/snapshots.ts queries        │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Next user boot:                      │
  │ getCompatibleSnapshot({              │
  │   playgroundId: "commerce",          │
  │   flavor: "opencode",                │
  │   setupVersion: 2  ◄── new version   │
  │ })                                   │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Query finds old snapshot:            │
  │ - playgroundId: ✅ match              │
  │ - flavor: ✅ match                    │
  │ - setupVersion: 1 ❌ mismatch         │
  │                                      │
  │ return null; // ignore old snapshot  │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Boot falls back to full install:     │
  │ - Clone repo                         │
  │ - npm install                        │
  │ - Install OpenCode v1.1 (new!)       │
  │ - Configure OpenCode                 │
  │                                      │
  │ (Slow boot, but has latest CLI)      │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Next day: Cron renewal runs          │
  │ - Creates sandbox with OpenCode v1.1 │
  │ - snapshot() captures v1.1           │
  │ - Saves with setupVersion: 2         │
  │ - Expires old snapshot (v1)          │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ Future boots:                        │
  │ getCompatibleSnapshot({              │
  │   setupVersion: 2                    │
  │ })                                   │
  │                                      │
  │ Found! ✅ Fast boot with v1.1         │
  └──────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ KEY INSIGHT:                            │
│ setupVersion acts as a cache key.       │
│ Bump it once, all old snapshots are     │
│ automatically invalidated until cron    │
│ creates new ones with the updated CLI.  │
│                                         │
│ No manual snapshot deletion needed!     │
└─────────────────────────────────────────┘
```

---

## 6. Deduplication Flow (Thundering Herd Prevention)

```
┌─────────────────────────────────────────────────────────────────────┐
│                       DEDUPLICATION                                  │
│      (What happens when multiple users hit a broken snapshot)        │
└─────────────────────────────────────────────────────────────────────┘

  Snapshot expires unexpectedly (cron missed it)
       │
       ▼
  ┌──────────────────────────────────────┐
  │ User 1 requests sandbox              │
  │ Boot from snapshotId fails ❌         │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ triggerSnapshotRenewal()             │
  │ 1. isSnapshotRenewing?               │
  │    → false (no one renewing yet)     │
  │ 2. markSnapshotRenewing()            │
  │    → status: "renewing" 🔒           │
  │ 3. Start renewal...                  │
  └──────────────────────────────────────┘
               │
               │ (renewal takes 4-6 min)
               │
               │ Meanwhile...
               ▼
  ┌──────────────────────────────────────┐
  │ User 2 requests sandbox              │
  │ Boot from snapshotId fails ❌         │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ triggerSnapshotRenewal()             │
  │ 1. isSnapshotRenewing?               │
  │    → true (User 1 already started!) │
  │ 2. Skip renewal                      │
  │    console.log("already renewing")   │
  │ 3. Return immediately                │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ User 2 falls back to git clone       │
  │ (Same as User 1)                     │
  └──────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Result:                                 │
│ - Only 1 renewal sandbox created       │
│ - User 1 & 2 both get git fallback     │
│ - User 3 (after renewal) gets fast boot│
│                                         │
│ Without deduplication:                  │
│ - 2 renewal sandboxes (wasted $$$)     │
│ - Race condition on snapshot update    │
└─────────────────────────────────────────┘
```

---

## 7. Error Recovery Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ERROR RECOVERY                               │
│           (What happens when renewal fails)                          │
└─────────────────────────────────────────────────────────────────────┘

  Renewal starts
       │
       ▼
  ┌──────────────────────────────────────┐
  │ Mark snapshot as "renewing" 🔒       │
  └────────────┬─────────────────────────┘
               │
               ▼
  ┌──────────────────────────────────────┐
  │ POST /api/snapshots/renew            │
  └────────────┬─────────────────────────┘
               │
         ┌─────┴─────┐
         │           │
    SUCCESS          FAILURE
         │           │
         ▼           ▼
  ┌────────────┐  ┌──────────────────────────────────────┐
  │ New        │  │ Failure scenarios:                   │
  │ snapshot   │  │ - npm install timeout                │
  │ created    │  │ - CLI download failed                │
  └────────────┘  │ - Vercel API error                   │
                  │ - Out of resources                   │
                  └────────────┬─────────────────────────┘
                               │
                               ▼
                  ┌──────────────────────────────────────┐
                  │ revertSnapshotRenewingToActive       │
                  │ 1. status: "renewing" → "active"     │
                  │ 2. lastRenewalError: "npm timeout"   │
                  └────────────┬─────────────────────────┘
                               │
                               ▼
                  ┌──────────────────────────────────────┐
                  │ Schedule retry after 1 hour          │
                  │ (SNAPSHOT_RENEWAL_RETRY_MS)          │
                  └────────────┬─────────────────────────┘
                               │
                               ▼
                         ⏰ 1 hour later
                               │
                               ▼
                  ┌──────────────────────────────────────┐
                  │ Try renewal again                    │
                  │ (same flow, with retry count)        │
                  └──────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Key properties:                         │
│ - Old snapshot stays active (users      │
│   can still boot, even if slow)         │
│ - Error message persisted for debugging │
│ - Automatic retry (exponential backoff) │
│ - No manual intervention needed         │
└─────────────────────────────────────────┘
```

---

## 8. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA FLOW                                    │
└─────────────────────────────────────────────────────────────────────┘

                   ┌──────────────────┐
                   │  Convex Database │
                   │   (snapshots)    │
                   └────────┬─────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
    ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
    │   Cron      │ │   Boot API   │ │  Renew API   │
    │  (daily)    │ │ (on-demand)  │ │  (internal)  │
    └──────┬──────┘ └──────┬───────┘ └──────┬───────┘
           │               │                │
           │ query         │ query          │ POST
           │ (expiring)    │ (compatible)   │ (renew)
           │               │                │
           ▼               ▼                ▼
    ┌─────────────────────────────────────────────┐
    │          Convex Queries/Mutations            │
    │                                              │
    │  • getCompatibleSnapshot                    │
    │  • isSnapshotRenewing                       │
    │  • markSnapshotRenewing                     │
    │  • registerOrUpdateSnapshot                 │
    │  • revertSnapshotRenewingToActive           │
    └────────────────┬────────────────────────────┘
                     │
                     │ write
                     │
                     ▼
           ┌──────────────────┐
           │  Snapshot Record │
           │                  │
           │  playgroundId    │
           │  snapshotId      │
           │  status          │
           │  flavor          │
           │  setupVersion    │
           │  expiresAt       │
           └──────────────────┘
```

---

## Summary

These diagrams show:

1. **System overview** — Three main components (storage, renewal, boot)
2. **Cron renewal** — Scheduled proactive refresh before expiration
3. **Boot optimization** — Fast path (snapshot) vs slow path (git)
4. **Ad-hoc renewal** — Background recovery when boot fails
5. **Version invalidation** — Automatic CLI update handling
6. **Deduplication** — Thundering herd prevention
7. **Error recovery** — Graceful failure with retry
8. **Data flow** — How components interact with Convex

The key insight: **Snapshots are versioned, cached, and automatically refreshed**. Users always get the latest working environment, with zero manual intervention.
