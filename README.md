# skillbox

try cursor agent skills in the browser. enter a path like `owner/repo/skill` and skillbox spins up a sandbox so you can run that skill without installing anything locally.

## how it works

- you enter a skill path (e.g. `remotion-dev/skills/remotion-best-practices`) or pick one from the carousel.
- you choose a playground repo (e.g. vercel/commerce, create/nextjs) or paste a custom repo. the skill runs in a clone of that repo inside the sandbox.
- you can use the opencode CLI (free) or the claude CLI (requires your anthropic api key). the sandbox gets a terminal (ttyd) and the skill is injected so the agent can use it.
- if the system is at capacity, you join a queue; when a slot frees up, you get your sandbox. sessions last 6 minutes.
- the backend tracks active sandboxes, the queue, and analytics (total sandboxes orchestrated) via convex.

## tech stack

- **frontend:** next.js 16, react 19, tailwind css
- **backend:** convex (realtime queries, mutations, crons, internal actions)
- **sandbox:** vercel sandbox sdk (create sandbox, install cli/ttyd, clone repo, inject skill, expose terminal)
- **api:** next.js route handlers for `POST /api/sandbox` (create) and `POST /api/sandbox/internal` (used by convex to create sandboxes from the queue)

## getting started

**prerequisites:** node 18+, pnpm

```bash
pnpm install
pnpm dev
```

this runs next.js and convex dev in parallel. then open the app in your browser.

**first-time convex:** if you have not linked this project to convex, run `pnpm convex:setup` (or `pnpm run dev` and follow the convex prompts) and set the env vars below.

## environment variables

**next.js (and vercel)**

- `NEXT_PUBLIC_CONVEX_URL` – convex deployment URL (from convex dashboard or `npx convex env get NEXT_PUBLIC_CONVEX_URL`).
- `NEXT_PUBLIC_APP_URL` – public URL of your app (e.g. `https://skillbox.vercel.app`). used by convex to call the sandbox internal API.
- `CONVEX_INTERNAL_SECRET` – shared secret so only convex can call `/api/sandbox/internal`. generate a random string and set it in both convex env and next.js/vercel env.
- optional: `ALLOW_INTERNAL_BYPASS=true` or `SKILLBOX_ALLOW_INTERNAL_BYPASS=true` – bypass internal secret check (dev only; do not use in production).

**convex**

- set `NEXT_PUBLIC_APP_URL` and `CONVEX_INTERNAL_SECRET` in the convex dashboard so internal actions can call your app’s internal route.

**vercel sandbox**

- creating sandboxes uses the vercel sandbox SDK. ensure your vercel project (or deployment) has access to sandbox resources and any required api keys for the environment where the next.js API routes run.

## project structure

- `app/` – next.js app router: home page, `[owner]/[repo]/[skill]` sandbox page, `api/sandbox` and `api/sandbox/internal` routes, shared components and data.
- `convex/` – schema (sandboxes, queue, analytics), sandbox lifecycle and queue logic, crons for cleanup and queue processing, analytics helpers.
- `app/data/skills.ts` – shared types and constants (playgrounds, top skills list, create sandbox request shape).

## deploy

1. deploy the next.js app (e.g. vercel) and convex (e.g. `npx convex deploy`).
2. set `NEXT_PUBLIC_APP_URL` to the production URL and ensure `CONVEX_INTERNAL_SECRET` and `NEXT_PUBLIC_CONVEX_URL` are set in both environments.
3. configure the vercel project so the sandbox API can create sandboxes (vcpus, timeout, ports as in the code).
