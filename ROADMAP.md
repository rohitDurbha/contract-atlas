# Contract Atlas roadmap

Work moves top to bottom, one step at a time. A step is ticked when it ships and an item is ticked when all of its steps are done.

Already shipped on Nov 3 and 4, 2026. Fifteen dead sources were retired (43 remain), the feed shows a 90-day contract-only window, reposted openings are collapsed, snapshot pruning brought the database from 30 MB to about 17 MB, a Cloudflare cron dispatcher keeps the two-hour refresh reliable, Vercel deploys on every code push, and the README was rewritten.

## Items

The MCP endpoint is live at `https://contract-atlas-amber.vercel.app/api/mcp` (stateless Streamable HTTP, no login).

- [ ] 1. MCP server with more tools, so AI assistants such as Claude can use the feed.
  - [x] a. Add a read-only remote MCP server at `/api/mcp` on the existing Vercel function using the official TypeScript MCP SDK and Streamable HTTP. Tools `search_jobs`, `get_job` and `list_sources` read the bundled SQLite snapshot through the same feed policy the site uses. Add tests.
  - [x] b. Add a `market_trends` tool that computes posting volume, top skills, categories and pay ranges over time from the snapshot in SQL.
  - [x] c. Add an `estimate_pay` tool. Train a simple regression on roles that list hourly pay (title words, skills, category, location, company) during the refresh workflow, save the coefficients as JSON next to the snapshot, and return a range clearly labeled as an estimate.
  - [x] d. Add a `match_resume` tool that takes resume text, ranks current roles by similarity (TF-IDF or small embeddings), explains the overlap and missing skills, and never stores the resume.
  - [ ] e. Document the server in the README with connection steps for Claude and other clients, add a `server.json`, and prepare publishing to the official MCP Registry.
- [ ] 2. Delete the unused Randstad and LiveHire adapter code and their tests.
- [ ] 3. Remove the legacy Cloudflare D1 path (root `wrangler.jsonc`, migrations, `build-worker`, `refresh-live`, `verify-live`, the scheduled export and the POST refresh routes) while keeping the Vercel and GitHub Actions path working.
- [ ] 4. Precompute the duplicate flag at collection time and add an index so feed requests do not run a window query on every call.
- [ ] 5. Mark sources with zero open roles clearly in the source directory and stop counting them as loaded.
- [ ] 6. LLM enrichment at collection time with a free Groq or Gemini key stored as a GitHub secret. Extract skills, seniority, normalized title, remote status and hourly pay into the snapshot so the site has no runtime AI cost.
- [ ] 7. Semantic search using small local embeddings (bge-small or MiniLM through fastembed) stored in SQLite with sqlite-vec, so people can describe the role they want in plain words.
- [ ] 8. Resume match that runs fully in the browser with transformers.js. The visitor drops a resume, it never leaves the device, and roles are ranked by similarity.
- [ ] 9. A trends page with Plotly or Recharts charts for skill demand, pay ranges and posting volume over time, plus a weekly LLM-written market summary.
- [ ] 10. Tests for the dispatcher worker, a CI workflow for pull requests, and README screenshots.

## Needs Rohit

- [ ] Deploy `dispatcher/` to Cloudflare Workers and add a GitHub token as described in the README deployment section.
- [ ] Add `GROQ_API_KEY` or `GEMINI_API_KEY` as a GitHub Actions secret before item 6.
- [ ] Log in with `mcp-publisher` so the MCP server can be listed in the official MCP Registry (item 1e).
