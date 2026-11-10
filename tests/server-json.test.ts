import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_INFO } from '../server/mcp';

// server.json is what the official MCP Registry lists, so it has to agree with
// the server the site actually runs and with the setup steps in the README.
const manifest = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const TOOLS = ['search_jobs', 'get_job', 'list_sources', 'market_trends', 'estimate_pay', 'match_resume'];

describe('MCP Registry manifest', () => {
  it('uses the registry schema and a GitHub namespace that matches the repository', () => {
    expect(manifest.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    expect(manifest.repository.source).toBe('github');
    const [, owner, repo] = manifest.repository.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/)!;
    expect(manifest.name).toBe(`io.github.${owner}/${repo}`);
  });

  it('matches the running server name, title and version', () => {
    expect(manifest.name.split('/')[1]).toBe(SERVER_INFO.name);
    expect(manifest.title).toBe(SERVER_INFO.title);
    expect(manifest.version).toBe(SERVER_INFO.version);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the description inside the registry length limit', () => {
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest.description.length).toBeLessThanOrEqual(100);
  });

  it('points at the public Streamable HTTP endpoint with no login', () => {
    expect(manifest.remotes).toHaveLength(1);
    const [remote] = manifest.remotes;
    expect(remote.type).toBe('streamable-http');
    expect(remote.url).toBe(`${manifest.websiteUrl}/api/mcp`);
    expect(remote.url.startsWith('https://')).toBe(true);
    expect(remote.headers).toBeUndefined();
    expect(manifest.packages).toBeUndefined();
  });

  it('is documented in the README with the same endpoint and every tool', () => {
    expect(readme).toContain(manifest.remotes[0].url);
    expect(readme).toContain(manifest.name);
    for (const tool of TOOLS) expect(readme).toContain('`' + tool + '`');
  });
});
