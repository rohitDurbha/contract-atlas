# Contract Atlas — free public hosting

A responsive contract-job feed with search, filters, saved roles, source health, and collection history. This release uses Vercel Hobby, a public GitHub repository, GitHub Actions, and a bundled SQLite database. It requires no paid database, paid hosting plan, GPT subscription, AI scraping agents, or purchased domain.

Deployment instructions: [FREE-DEPLOYMENT.md](FREE-DEPLOYMENT.md). The public deployment is live at https://contract-atlas-amber.vercel.app/. Scheduled refreshes remain pending the `VERCEL_TOKEN` GitHub Actions secret and verification of the first successful run.

## Architecture

| Component | Implementation |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS, TanStack Query |
| Public API | Hono on a Vercel Node.js 24 function |
| Database | Read-only SQLite snapshot bundled with the function |
| Collector | Existing deterministic TypeScript source adapters on GitHub Actions |
| Persistence | Public repository commits to `data/atlas.sqlite` |
| Hosting | Vercel Hobby and its included public `vercel.app` URL |

The workflow checks the 59 registered public company portals every two hours, updates and verifies the database, commits it, and publishes the next snapshot. Visitors keep using the previous deployment during collection and publishing. Scheduled start times can be delayed by GitHub; source timestamps show actual freshness.

Registration does not mean every portal can be collected completely. The source directory reports complete, partial, blocked, pending, and failed coverage. Only actual public listings enter the feed. Login walls, access restrictions, and robots exclusions are respected. There are no fabricated roles or AI-generated listing data.

## Development

Requires Node.js 24. Use separate terminals for the API and UI:

```bash
npm ci
npm run dev:api
```

```bash
npm run dev
```

Vite proxies `/api` to the local read-only snapshot server on port 8787. Open the URL printed by Vite. Run `npm run collect:free` to collect permitted public sources locally; Vercel receives changes only through a new deployment.

```bash
npm run typecheck
npm test
npm run build:free
npm run verify:free
```

## Public API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/jobs` | Search, filters, sorting, pagination, facets |
| `GET /api/jobs/:id` | Details and original application link |
| `GET /api/overview` | Feed counts, source health, collection status |
| `GET /api/sources` | All source statuses and collection timestamps |
| `GET /api/runs` | Latest twenty persisted collection runs |
| `GET /api/access` | Public API permissions |

Public mutations return 405. “Reload feed” reads the latest published snapshot; collection runs in GitHub Actions, including manual workflow runs. Saved roles remain in localStorage on each visitor's device, without a paid authentication service.

## Data integrity

Stable source IDs preserve first discovery across updates. Posting times come from the source; missing dates remain missing. Pay stays unset when the source omits it. TalentNet collection follows the public feed's pagination and verifies distinct source IDs against advertised counts before claiming complete coverage.

Blocked or failed sources retain existing jobs and last-success timestamps. Only confirmed complete collections can expire unseen listings, after at least 48 hours. Generic HTML adapters remain explicitly partial and do not remove unseen roles.

The included bootstrap snapshot was exported from the existing feed on October 1, 2026. It contains 654 active listings, all 59 source records, and the 13 runs available from the export API. Historical inactive rows that were not exposed by that API remain in the original database; this is not a full archival dump.

## Free-plan enforcement

The workflow refuses to run in a private repository and refuses to publish unless the authenticated Vercel scope is verified as Hobby. It uses standard public GitHub Actions runners, without paid runners, Actions caches, or uploaded artifacts. Credentials belong in GitHub Actions secrets, never public code or database rows.

Free services impose quotas and availability limits. This release pauses or fails at those limits; it does not purchase upgrades. Vercel Hobby is intended for personal, non-commercial projects. Older Cloudflare compatibility files remain for maintenance; this deployment uses the SQLite scripts and Vercel configuration above.
