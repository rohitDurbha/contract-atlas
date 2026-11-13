# Contract Atlas roadmap

Work moves top to bottom, one step at a time. A step is ticked when it ships and an item is ticked when all of its steps are done.

Already shipped on Nov 3 and 4, 2026. Fifteen dead sources were retired (43 remain), the feed shows a 90-day contract-only window, reposted openings are collapsed, snapshot pruning brought the database from 30 MB to about 17 MB, a Cloudflare cron dispatcher keeps the two-hour refresh reliable, Vercel deploys on every code push, and the README was rewritten.

## Items

The MCP endpoint is live at `https://contract-atlas-amber.vercel.app/api/mcp` (stateless Streamable HTTP, no login).

- [x] 1. MCP server with more tools, so AI assistants such as Claude can use the feed.
  - [x] a. Add a read-only remote MCP server at `/api/mcp` on the existing Vercel function using the official TypeScript MCP SDK and Streamable HTTP. Tools `search_jobs`, `get_job` and `list_sources` read the bundled SQLite snapshot through the same feed policy the site uses. Add tests.
  - [x] b. Add a `market_trends` tool that computes posting volume, top skills, categories and pay ranges over time from the snapshot in SQL.
  - [x] c. Add an `estimate_pay` tool. Train a simple regression on roles that list hourly pay (title words, skills, category, location, company) during the refresh workflow, save the coefficients as JSON next to the snapshot, and return a range clearly labeled as an estimate.
  - [x] d. Add a `match_resume` tool that takes resume text, ranks current roles by similarity (TF-IDF or small embeddings), explains the overlap and missing skills, and never stores the resume.
  - [x] e. Document the server in the README with connection steps for Claude and other clients, add a `server.json`, and prepare publishing to the official MCP Registry.
- [x] 2. Delete the unused Randstad and LiveHire adapter code and their tests.
  - [x] a. Remove the Randstad feed (`randstadFeed`, `parseRandstad` and the provider branch in the collector) together with its tests, since every Randstad board is retired.
  - [x] b. Drop `Randstad` and `LiveHire` from the provider type, remove the retired Randstad and LiveHire entries from `server/seed.json`, and point the test fixtures that still use those provider names at a live provider.
- [ ] 3. Remove the legacy Cloudflare D1 path (root `wrangler.jsonc`, migrations, `build-worker`, `refresh-live`, `verify-live`, the scheduled export and the POST refresh routes) while keeping the Vercel and GitHub Actions path working.
  - [x] a. Delete the Cloudflare deployment files, which are the root `wrangler.jsonc`, `migrations/`, `scripts/build-worker.mjs`, `scripts/refresh-live.mjs`, `scripts/verify-live.mjs` and the `db:local` and `preview` npm scripts. Keep `wrangler` as a dev dependency because the dispatcher deploy still uses it.
  - [ ] b. Remove the scheduled export, the POST refresh, refresh step and schedule settings routes and the static asset fallback from `server/index.ts`, drop `startRun` and `stepRun` if nothing else needs them, and update the API tests.
  - [ ] c. Replace the `D1Database` type with a small database interface over `node:sqlite`, so `@cloudflare/workers-types` and the Drizzle D1 driver are no longer needed.
- [ ] 4. Precompute the duplicate flag at collection time and add an index so feed requests do not run a window query on every call.
  - [x] a. Add a `duplicate` column to `jobs` (with a migration for snapshots that predate it) and a `markDuplicates` function that sets the flag in one statement for every reposted opening the feed currently hides. Add tests that compare it with the live window query.
  - [ ] b. Run `markDuplicates` at the end of every refresh and when the snapshot is built, then switch `feedScopeSql` to read the flag instead of the window query.
  - [ ] c. Add an index that covers the flag and the freshness columns, and make `verify:free` fail when the stored flags disagree with a fresh window query.
- [ ] 5. Mark sources with zero open roles clearly in the source directory and stop counting them as loaded.
- [ ] 6. LLM enrichment at collection time with a free Groq or Gemini key stored as a GitHub secret. Extract skills, seniority, normalized title, remote status and hourly pay into the snapshot so the site has no runtime AI cost.
- [ ] 7. Semantic search using small local embeddings (bge-small or MiniLM through fastembed) stored in SQLite with sqlite-vec, so people can describe the role they want in plain words.
- [ ] 8. Resume match that runs fully in the browser with transformers.js. The visitor drops a resume, it never leaves the device, and roles are ranked by similarity.
- [ ] 9. A trends page with Plotly or Recharts charts for skill demand, pay ranges and posting volume over time, plus a weekly LLM-written market summary.
- [ ] 10. Tests for the dispatcher worker, a CI workflow for pull requests, and README screenshots.

## Needs Rohit

- [ ] Deploy `dispatcher/` to Cloudflare Workers and add a GitHub token as described in the README deployment section.
- [ ] Add `GROQ_API_KEY` or `GEMINI_API_KEY` as a GitHub Actions secret before item 6.
- [ ] List the MCP server in the official MCP Registry (item 1e). Start the Publish to MCP Registry workflow once from the Actions tab. It signs in with GitHub OIDC, so no secret is needed. Running `mcp-publisher login github` and then `mcp-publisher publish` from a laptop works too.
