# Contract Atlas

Contract Atlas is a searchable feed of technical contract roles collected from the public job boards that large companies use for their contingent workforce. It pulls listings from 43 portals across TalentNet, Magnit, KellyOCG, Raise, Insight Global, INSPYR and Tundra, cleans them up, and publishes a fresh snapshot every two hours.

You can browse the live feed at **https://contract-atlas-amber.vercel.app**.

## What it does

- Lists software, data, AI and research contract roles that were posted within the last 90 days.
- Leaves out permanent and direct hire roles that mixed staffing boards publish next to their contract work.
- Shows a single listing when a company reposts the same opening under several requisition IDs.
- Offers search, filters for company, category, work mode and country, sorting by date or pay, and saved roles that stay on the visitor's own device.
- Reports the health of every source, including whether its last collection was complete or only partial.

Every listing comes from a real public posting. The collector respects robots.txt, login walls and access restrictions, and it never invents or generates job data.

## How it works

| Piece | What it uses |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS and TanStack Query |
| API | Hono running as a Vercel Node.js function |
| Data | A read-only SQLite snapshot in `data/atlas.sqlite` that ships with the function |
| Collector | TypeScript source adapters that run in GitHub Actions |
| Scheduler | GitHub Actions cron with a Cloudflare Worker that starts runs on time |
| Hosting | Vercel Hobby with the included `vercel.app` domain |

The refresh workflow in `.github/workflows/refresh.yml` collects every source, verifies the database, commits the new snapshot and deploys it to Vercel. Visitors keep seeing the previous deployment until the new one passes its checks. After each run the collector deletes closed, expired and out of scope rows so the committed snapshot stays small.

The workflow runs in three situations.

1. Every two hours on a schedule, started by the Cloudflare dispatcher in `dispatcher/` because GitHub often skips scheduled runs when it is busy.
2. On every push to `main` that changes code, so each fix is tested and goes live within a few minutes.
3. By hand from the Actions tab whenever a manual refresh is needed.

Pushes that only change Markdown files or the snapshot do not start a deploy. Vercel's own Git integration is turned off in `vercel.json`, so the site never builds twice.

## Running it locally

Local development needs Node.js 24, with the API running in one terminal and the frontend in another.

```bash
npm ci
npm run dev:api
```

```bash
npm run dev
```

Vite forwards `/api` requests to the local snapshot server on port 8787. To collect fresh data on your own machine, run `npm run collect:free`.

These commands are the same checks the workflow runs before it deploys.

```bash
npm run typecheck
npm test
npm run build:free
npm run verify:free
```

## Public API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/jobs` | Search, filters, sorting, pagination and facets |
| `GET /api/jobs/:id` | Full details and the original application link |
| `GET /api/overview` | Feed counts, source health and the latest run |
| `GET /api/sources` | Status and collection times for every source |
| `GET /api/runs` | The twenty most recent collection runs |
| `GET /api/access` | Public API permissions |
| `POST /api/mcp` | MCP server for AI assistants (see below) |

The public API is read-only. Write requests to the REST endpoints return 405, and the MCP endpoint accepts POST only because MCP sends its read requests as JSON-RPC.

## MCP server

AI assistants such as Claude can search the feed through a read-only Model Context Protocol server at `https://contract-atlas-amber.vercel.app/api/mcp`. It uses stateless Streamable HTTP and needs no login, so any MCP client that supports remote servers can connect to that URL directly. In Claude you can add it as a custom connector with that address.

| Tool | What it returns |
| --- | --- |
| `search_jobs` | Matching roles with short summaries, the total count and filter facets, using the same filters as the website |
| `get_job` | One role with its full description, skills, pay and apply link |
| `list_sources` | Every job board in the feed with its health, coverage and current role count |

Every tool reads the bundled snapshot through the same feed policy as the site, so an assistant sees exactly what a visitor would. When `npm run dev:api` is running, the same server is available locally at `http://127.0.0.1:8787/api/mcp`. More tools and full client setup guides are planned in [ROADMAP.md](ROADMAP.md).

## Deployment setup

The site runs entirely on free plans. The workflow stops if the repository becomes private or if the Vercel scope is not on the Hobby plan, so it can never trigger a paid upgrade.

1. Keep this repository public so GitHub Actions minutes stay free.
2. Store a Vercel token for the `rohitdurbha-1631` scope as the GitHub Actions secret `VERCEL_TOKEN`. The Vercel project and team IDs in the workflow are public identifiers and are not secrets.
3. Allow GitHub Actions to write repository contents so it can commit each new snapshot.

To turn on the reliable two hour schedule, deploy the dispatcher to the Cloudflare Workers free plan.

1. Create a fine-grained GitHub token for this repository with read and write access to Actions.
2. Run `npx wrangler login` and then `npx wrangler deploy --config dispatcher/wrangler.jsonc` from the repository root.
3. Run `npx wrangler secret put GITHUB_TOKEN --config dispatcher/wrangler.jsonc` and paste the token when it asks.
4. After the next even hour, open the worker's `/status` page to confirm that a `workflow_dispatch` run started.

The GitHub schedule stays in place as a backup. All runs share one concurrency group, so two collections never overlap.

## Data rules

- Stable source IDs keep the original discovery date when a role is seen again.
- Posting dates and pay come straight from the source and stay empty when the source leaves them out.
- A blocked or failing source keeps its earlier listings until it recovers.
- Only a complete collection can retire listings, and only after they have been missing for 48 hours.
- Closed listings are deleted after two weeks, and rows older than 120 days are removed from the snapshot.

## Limits

Free services come with quotas. If GitHub Actions or Vercel reach a limit, collection or publishing pauses until the allowance resets. Vercel Hobby is meant for personal and non-commercial projects, which fits this one.
