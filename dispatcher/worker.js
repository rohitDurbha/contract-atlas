// Free Cloudflare Worker that starts the refresh workflow on time.
//
// GitHub runs scheduled workflows on a best-effort basis and drops many of
// them when its queue is busy. In practice the two-hour schedule ran only three
// or four times a day. Cloudflare cron triggers are reliable on the free plan,
// so this worker asks GitHub to start the workflow every two hours instead.
//
// Secrets (set with `npx wrangler secret put GITHUB_TOKEN`):
//   GITHUB_TOKEN  fine-grained token with Actions read and write on this repo
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // GET /status reports the latest run so the trigger can be checked by hand.
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/status') return new Response('Not found', { status: 404 });
    const response = await github(env, `actions/workflows/${env.WORKFLOW}/runs?per_page=1`);
    const data = await response.json();
    const run = data.workflow_runs?.[0];
    return Response.json(run ? { status: run.status, conclusion: run.conclusion, event: run.event, startedAt: run.run_started_at } : { status: 'none' });
  },
};

async function dispatch(env) {
  const response = await github(env, `actions/workflows/${env.WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: env.BRANCH }),
  });
  if (response.status !== 204) throw new Error(`Workflow dispatch failed with HTTP ${response.status}: ${await response.text()}`);
}

function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPOSITORY}/${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'contract-atlas-dispatcher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}
