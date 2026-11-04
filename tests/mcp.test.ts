import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import { createAtlasMcpHandler } from '../server/mcp';
import publicAPI from '../api/index';

type Fetch = (request: Request) => Promise<Response>;
const PROTOCOL = '2025-06-18';
let nextId = 1;

async function rpc(fetch: Fetch, url: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  }));
  expect(response.status).toBe(200);
  const body = await response.text();
  // Streamable HTTP may answer with a JSON body or a one-message SSE stream.
  const json = body.trimStart().startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data: '))!.slice(6);
  return JSON.parse(json);
}
const callTool = async (fetch: Fetch, name: string, args: Record<string, unknown> = {}) =>
  (await rpc(fetch, 'https://atlas.test/api/mcp', 'tools/call', { name, arguments: args })).result;

describe('MCP server on a controlled database', () => {
  const sqlite = openSQLite(':memory:');
  const handler = createAtlasMcpHandler(sqlite.db);
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const old = new Date(Date.now() - 120 * 86_400_000).toISOString();

  beforeAll(async () => {
    await ensureDB(sqlite.db);
    await sqlite.db.prepare('DELETE FROM jobs').run();
    const add = (source: number, id: string, title: string, extra: Record<string, unknown> = {}) =>
      jobStatement(sqlite.db, makeJob(SOURCES[source], { sourceJobId: id, title, applyUrl: 'https://example.com/jobs/' + id, postedAt: recent, description: 'Builds data pipelines in Python and SQL.', ...extra }, recent)!).run();
    await add(0, 'eng', 'Software Engineer', { location: 'Seattle, WA', payMin: 70, payMax: 90, payPeriod: 'hour', currency: 'USD' });
    await add(0, 'remote', 'Data Engineer', { location: 'Remote', workMode: 'Remote' });
    await add(1, 'ml', 'Machine Learning Engineer', { location: 'Redmond, WA' });
    await add(1, 'retail', 'Retail Associate');
    await add(1, 'stale', 'Data Analyst', { postedAt: old });
  });
  afterAll(() => sqlite.close());

  it('lists the three read-only tools with input schemas', async () => {
    const { result } = await rpc(handler.fetch, 'https://atlas.test/api/mcp', 'tools/list');
    const tools = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual(['get_job', 'list_sources', 'search_jobs']);
    for (const tool of Object.values(tools) as any[]) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(tools.search_jobs.inputSchema.properties).toHaveProperty('query');
  });

  it('searches with the same feed policy and filters as the website', async () => {
    const all = (await callTool(handler.fetch, 'search_jobs')).structuredContent;
    expect(all.total).toBe(3);
    expect(all.jobs.map((j: any) => j.title)).not.toContain('Retail Associate');
    expect(all.jobs.map((j: any) => j.title)).not.toContain('Data Analyst');
    expect(all.facets.companies.map((c: any) => c.name).sort()).toEqual([SOURCES[0].company, SOURCES[1].company].sort());

    const meta = (await callTool(handler.fetch, 'search_jobs', { company: [SOURCES[0].company] })).structuredContent;
    expect(meta.total).toBe(2);
    const remote = (await callTool(handler.fetch, 'search_jobs', { workMode: ['Remote'] })).structuredContent;
    expect(remote.jobs.map((j: any) => j.id)).toEqual([`${SOURCES[0].id}:remote`]);
    const text = (await callTool(handler.fetch, 'search_jobs', { query: 'machine learning' })).structuredContent;
    expect(text.jobs.map((j: any) => j.title)).toEqual(['Machine Learning Engineer']);
    const paid = (await callTool(handler.fetch, 'search_jobs', { sort: 'pay' })).structuredContent;
    expect(paid.jobs).toHaveLength(1);
    expect(paid.jobs[0].pay).toBe('USD 70-90 per hour');
  });

  it('rejects arguments outside the schema', async () => {
    const result = await callTool(handler.fetch, 'search_jobs', { workMode: ['Underwater'] });
    expect(result.isError).toBe(true);
  });

  it('returns a full role and reports roles outside the feed as errors', async () => {
    const job = (await callTool(handler.fetch, 'get_job', { id: `${SOURCES[0].id}:eng` })).structuredContent;
    expect(job.title).toBe('Software Engineer');
    expect(job.description).toContain('data pipelines');
    expect(job.applyUrl).toBe('https://example.com/jobs/eng');
    for (const hidden of [`${SOURCES[1].id}:retail`, `${SOURCES[1].id}:stale`, 'missing:role']) {
      const result = await callTool(handler.fetch, 'get_job', { id: hidden });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(hidden);
    }
  });

  it('lists sources with live role counts', async () => {
    const { count, sources } = (await callTool(handler.fetch, 'list_sources')).structuredContent;
    expect(count).toBe(SOURCES.length);
    expect(sources.find((s: any) => s.id === SOURCES[0].id).jobCount).toBe(2);
    expect(sources.find((s: any) => s.id === SOURCES[1].id).jobCount).toBe(1);
  });
});

describe('MCP endpoint on the public Vercel function', () => {
  const url = 'https://atlas.test/api/index?__atlasRoute=mcp';

  it('initializes over the rewritten route and serves the bundled snapshot', async () => {
    const init = await rpc(publicAPI.fetch, url, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'vitest', version: '1.0.0' } });
    expect(init.result.serverInfo.name).toBe('contract-atlas');
    expect(init.result.capabilities.tools).toBeDefined();

    const search = await rpc(publicAPI.fetch, url, 'tools/call', { name: 'search_jobs', arguments: {} });
    const feed = await (await publicAPI.fetch(new Request('https://atlas.test/api/index?__atlasRoute=jobs'))).json() as any;
    expect(search.result.structuredContent.total).toBe(feed.total);
    expect(search.result.structuredContent.jobs[0].id).toBe(feed.jobs[0].id);
  });

  it('does not open sessions or accept writes on the REST API', async () => {
    expect((await publicAPI.fetch(new Request(url, { method: 'GET', headers: { accept: 'text/event-stream' } }))).status).toBe(405);
    expect((await publicAPI.fetch(new Request('https://atlas.test/api/index?__atlasRoute=refresh', { method: 'POST' }))).status).toBe(405);
  });
});
