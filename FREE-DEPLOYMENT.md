# Publish Contract Atlas without paid services

## Required free accounts

- GitHub: use a **public repository**, so standard hosted Actions runners are free.
- Vercel: use a **Hobby** scope for this personal, non-commercial job-search project. Decline Pro, paid trials, add-ons, and purchased domains.

Use the included `vercel.app` domain. This release has no Replit deployment, hosted PostgreSQL database, OpenAI/GPT API key, or AI agent dependency.

Official references: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [scheduled Actions limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Setup

1. Create a public GitHub repository and upload this release ZIP's contents, including `.github/workflows/refresh.yml` and `data/atlas.sqlite`. The workflow must be on the default branch. The ZIP excludes the old Sites hosting manifest and credentials.
2. In a Vercel **Hobby** scope, import the public repository as a project. Use Node.js 24 and the included `vercel.json`. Decline upgrades and paid resources. An initial import can publish the bootstrap snapshot; it does not mean scheduled collection is running yet.
3. The workflow is linked to the verified `contract-atlas` project in `rohitdurbha-1631` through public project and team identifiers. To deploy a different copy, update those identifiers in the workflow. The organization must be a `team_…` scope with `billing.plan=hobby`; the workflow fails closed if it cannot verify this.
4. Create a Vercel token scoped to `rohitdurbha-1631`. Save it directly as the **GitHub Actions repository secret `VERCEL_TOKEN`**. Never paste the token into chat, files, URLs, frontend values, or public repository variables. Project and team IDs are already configured and are not credentials.

5. Allow GitHub Actions to write repository contents so it can commit the snapshot. Keep the standard `ubuntu-latest` runner, without paid runners, caches, or artifacts.
6. Select **Actions → Refresh Contract Atlas → Run workflow**. It checks public visibility and the Hobby plan, collects sources, verifies the database, commits it, and deploys. Blocked sources preserve earlier listings. Wholly failed ingestion or failed verification stops publishing.
7. Verify the public URL without ChatGPT: `/api/overview` shows the latest run, `/api/sources` returns 59 source records with actual timestamps, and `/api/jobs?q=Data%20Labeling%20Analyst` returns indexed matches. Test search, source health, saved roles, and application links.
8. After the public site and a successful Actions run are verified, disable the previous GPT-driven refresh task. The original deployment remains available during migration.

Automatic Git-triggered Vercel deployment is disabled in `vercel.json`. Scheduled refreshes publish explicitly after the free-plan guard, avoiding duplicate builds. For frontend changes, run the same workflow manually after committing them.

## Timing, persistence, and limits

The workflow runs at minute 17 of every even UTC hour. GitHub may delay jobs, so this is a best-effort two-hour schedule. Runs have a 25-minute timeout; source steps have collection deadlines and adapter retry limits. Concurrent workflows are serialized.

SQLite stores normalized jobs, coverage, truthful posting/discovery dates, source health, leases, and collection history. The workflow commits the database before publishing; Vercel serves its bundled copy read-only. An interrupted workflow leaves the deployed feed untouched. A later run starts from the latest committed snapshot; uncommitted work from a killed runner is not durable.

GitHub can disable schedules after 60 days of repository inactivity. Snapshot commits normally keep this repository active; inspect Actions if refresh timestamps stop advancing. If Actions or Vercel quotas are reached, collection or publishing stops until the allowance resets or the issue is fixed. Do not upgrade automatically.

## Credentials and public data

Code and public job snapshots are public by choice. Snapshots contain postings and source health, not candidate accounts or private applications. The collector respects existing restrictions and does not bypass blocked or sign-in-only sources. Keep Vercel credentials only in encrypted GitHub Actions secrets.

## Current release status

Public deployment verified on October 8, 2026 at https://contract-atlas-amber.vercel.app/. The anonymous API returns 654 active listings, 59 sources, and 40 Data Labeling Analyst matches from the October 1 snapshot. Vercel settings confirm Hobby. Scheduled collection is pending the `VERCEL_TOKEN` repository secret and its first successful Actions run. No paid resource is requested. The original deployment is retained until migration is verified.
