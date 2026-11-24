import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { pruneSnapshot } from '../server/prune';
import { SOURCES } from '../server/sources';
import {
  ENRICH_DEFAULT_DELAY_MS, ENRICH_DEFAULT_LIMIT, ENRICHMENT_MODELS, enrichPending, enrichmentInput, enrichmentProblems, inputHash, loadEnrichment, parseEnrichment,
  pendingEnrichment, providersFromEnv, requestEnrichment, runOptionsFromEnv, saveEnrichment,
} from '../server/enrichment';

const role = {
  title: 'Sr. Data Engineer (Contract, W2) - Remote',
  company: 'Acme',
  location: 'Austin, TX',
  workMode: 'Remote' as const,
  description: '<p>Build pipelines in <b>Python</b> &amp; Spark.</p>',
  payMin: 70, payMax: 85, payPeriod: 'hour', currency: 'USD',
};
const good = { skills: ['Python', 'Spark', 'python', ''], seniority: 'Senior', normalizedTitle: ' Senior  Data Engineer ', remote: 'Remote', hourlyPayMin: 70, hourlyPayMax: 85 };

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('enrichment providers', () => {
  it('uses nothing without a key', () => {
    expect(providersFromEnv({})).toEqual([]);
    expect(providersFromEnv({ GROQ_API_KEY: '  ' })).toEqual([]);
  });

  it('puts Groq first and Gemini second with default or overridden models', () => {
    expect(providersFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' })).toEqual([
      { name: 'groq', model: ENRICHMENT_MODELS.groq, apiKey: 'q' },
      { name: 'gemini', model: ENRICHMENT_MODELS.gemini, apiKey: 'g' },
    ]);
    expect(providersFromEnv({ GEMINI_API_KEY: 'g', ENRICH_GEMINI_MODEL: 'gemini-next' })).toEqual([{ name: 'gemini', model: 'gemini-next', apiKey: 'g' }]);
  });
});

describe('enrichment input', () => {
  it('sends plain text and the listed pay', () => {
    const text = enrichmentInput(role);
    expect(text).toContain('Description: Build pipelines in Python & Spark.');
    expect(text).toContain('Listed pay: 70-85 USD per hour');
    expect(enrichmentInput({ ...role, payMin: null, payMax: null })).toContain('Listed pay: not listed');
  });

  it('hashes the same text the same way and changed text differently', () => {
    expect(inputHash(enrichmentInput(role))).toBe(inputHash(enrichmentInput({ ...role })));
    expect(inputHash(enrichmentInput(role))).not.toBe(inputHash(enrichmentInput({ ...role, title: 'Data Engineer' })));
  });
});

describe('parsing model answers', () => {
  it('cleans a valid answer', () => {
    expect(parseEnrichment(JSON.stringify(good))).toEqual({
      skills: ['Python', 'Spark'], seniority: 'senior', normalizedTitle: 'Senior Data Engineer', remote: 'remote', hourlyPayMin: 70, hourlyPayMax: 85,
    });
  });

  it('accepts a fenced answer and swaps a reversed pay range', () => {
    const parsed = parseEnrichment('```json\n' + JSON.stringify({ ...good, hourlyPayMin: '90', hourlyPayMax: 60 }) + '\n```');
    expect(parsed).toMatchObject({ hourlyPayMin: 60, hourlyPayMax: 90 });
  });

  it('falls back to unknown labels and drops pay outside the sanity band', () => {
    const parsed = parseEnrichment(JSON.stringify({ skills: 'Python', seniority: 'wizard', normalizedTitle: 3, remote: 'on-site?', hourlyPayMin: 2, hourlyPayMax: 150000 }));
    expect(parsed).toEqual({ skills: [], seniority: 'unknown', normalizedTitle: '', remote: 'onsite', hourlyPayMin: null, hourlyPayMax: null });
    expect(parseEnrichment(JSON.stringify({ ...good, remote: 'sometimes' }))?.remote).toBe('unknown');
  });

  it('rejects text that is not a JSON object', () => {
    expect(parseEnrichment('Sorry, I cannot help with that.')).toBeNull();
    expect(parseEnrichment('[1,2]')).toBeNull();
  });
});

describe('requesting enrichment', () => {
  const groq = { name: 'groq' as const, model: 'm1', apiKey: 'q' };
  const gemini = { name: 'gemini' as const, model: 'm2', apiKey: 'g' };

  it('sends a structured output request to Groq', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply(200, { choices: [{ message: { content: JSON.stringify(good) } }] });
    }) as unknown as typeof globalThis.fetch;
    const result = await requestEnrichment([groq], 'input', { fetch });
    expect(result?.provider).toBe(groq);
    expect(result?.enrichment.seniority).toBe('senior');
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer q');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('m1');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'input' });
  });

  it('falls back to Gemini when Groq fails', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      if (url.includes('groq')) return reply(429, { error: 'rate limited' });
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] });
    }) as unknown as typeof globalThis.fetch;
    const result = await requestEnrichment([groq, gemini], 'input', { fetch });
    expect(result?.provider).toBe(gemini);
    expect(urls[1]).toBe('https://generativelanguage.googleapis.com/v1beta/models/m2:generateContent');
  });

  it('returns null when every provider fails or answers badly', async () => {
    const fetch = (async (url: string) => {
      if (url.includes('groq')) throw new Error('network down');
      return reply(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
    }) as unknown as typeof globalThis.fetch;
    expect(await requestEnrichment([groq, gemini], 'input', { fetch })).toBeNull();
    expect(await requestEnrichment([], 'input', { fetch })).toBeNull();
  });

  it('reports a short reason for every provider that fails', async () => {
    const reasons: string[] = [];
    const onFailure = (reason: string) => reasons.push(reason);
    const fetch = (async (url: string) => {
      if (url.includes('groq')) return reply(400, { error: { message: 'Failed to validate JSON', type: 'invalid_request_error', code: 'json_validate_failed' } });
      return reply(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
    }) as unknown as typeof globalThis.fetch;
    expect(await requestEnrichment([groq, gemini], 'input', { fetch, onFailure })).toBeNull();
    expect(reasons).toEqual(['groq: HTTP 400 json_validate_failed', 'gemini: HTTP 429 RESOURCE_EXHAUSTED']);

    reasons.length = 0;
    const odd = (async (url: string) => {
      if (url.includes('groq')) throw new Error('connect failed for key q\nstack');
      return reply(200, { candidates: [{ content: { parts: [{ text: '[1, 2]' }] } }] });
    }) as unknown as typeof globalThis.fetch;
    expect(await requestEnrichment([{ ...groq, apiKey: 'secret-key' }, gemini], 'input', { fetch: odd, onFailure })).toBeNull();
    expect(reasons).toEqual(['groq: connect failed for key q', 'gemini: answer did not match the schema']);

    reasons.length = 0;
    const leaky = (async () => { throw new Error('bad header secret-key'); }) as unknown as typeof globalThis.fetch;
    const slow = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof globalThis.fetch;
    await requestEnrichment([{ ...groq, apiKey: 'secret-key' }], 'input', { fetch: leaky, onFailure });
    await requestEnrichment([groq], 'input', { fetch: slow, onFailure, timeoutMs: 5 });
    await requestEnrichment([groq], 'input', { fetch: (async () => reply(500, 'oops')) as unknown as typeof globalThis.fetch, onFailure });
    expect(reasons).toEqual(['groq: bad header ***', 'groq: timed out', 'groq: HTTP 500']);
  });
});

describe('storing enrichment', () => {
  it('creates the table, saves an answer and replaces it on the next save', async () => {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      const provider = { name: 'groq' as const, model: 'm1', apiKey: 'q' };
      const enrichment = parseEnrichment(JSON.stringify(good))!;
      await saveEnrichment(db, 'job-1', 'h1', { enrichment, provider }, new Date('2026-11-19T17:00:00.000Z'));
      expect(await loadEnrichment(db, 'job-1')).toEqual({ ...enrichment, inputHash: 'h1', provider: 'groq', model: 'm1', enrichedAt: '2026-11-19T17:00:00.000Z' });
      await saveEnrichment(db, 'job-1', 'h2', { enrichment: { ...enrichment, seniority: 'lead' }, provider });
      expect(await loadEnrichment(db, 'job-1')).toMatchObject({ inputHash: 'h2', seniority: 'lead' });
      expect(await loadEnrichment(db, 'missing')).toBeNull();
    } finally {
      close();
    }
  });
});

describe('enriching pending roles during a refresh', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const id = (key: string) => `${SOURCES[0].id}:${key}`;
  const groq = { name: 'groq' as const, model: 'm1', apiKey: 'q' };
  const answer = () => reply(200, { choices: [{ message: { content: JSON.stringify(good) } }] });
  const noSleep = async () => {};

  async function withRoles(test: (db: ReturnType<typeof openSQLite>['db'], add: (key: string, title: string, posted: number, description?: string) => Promise<unknown>) => Promise<void>) {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare('DELETE FROM jobs').run();
      const add = (key: string, title: string, posted: number, description = 'Build services in Python.') =>
        jobStatement(db, makeJob(SOURCES[0], { sourceJobId: key, title, applyUrl: 'https://example.com/jobs/' + key, postedAt: daysAgo(posted), description }, now.toISOString())!).run();
      await test(db, add);
    } finally {
      close();
    }
  }

  it('reads the cap and delay from the environment with safe defaults', () => {
    expect(runOptionsFromEnv({})).toEqual({ limit: ENRICH_DEFAULT_LIMIT, delayMs: ENRICH_DEFAULT_DELAY_MS });
    expect(runOptionsFromEnv({ ENRICH_MAX_PER_RUN: '5', ENRICH_DELAY_MS: '0' })).toEqual({ limit: 5, delayMs: 0 });
    expect(runOptionsFromEnv({ ENRICH_MAX_PER_RUN: 'lots', ENRICH_DELAY_MS: '-1' })).toEqual({ limit: ENRICH_DEFAULT_LIMIT, delayMs: ENRICH_DEFAULT_DELAY_MS });
  });

  it('lists feed roles newest first and skips roles outside the feed', () => withRoles(async (db, add) => {
    await add('a', 'Data Engineer', 3);
    await add('b', 'Software Engineer', 1);
    await add('old', 'Data Engineer', 200);
    await add('clerk', 'Office Assistant', 1);
    expect((await pendingEnrichment(db, now)).map(p => p.jobId)).toEqual([id('b'), id('a')]);
  }));

  it('skips the run and makes no calls without a provider', () => withRoles(async (db, add) => {
    await add('a', 'Data Engineer', 1);
    let calls = 0;
    const fetch = (async () => { calls++; return answer(); }) as unknown as typeof globalThis.fetch;
    expect(await enrichPending(db, [], { fetch, now })).toMatchObject({ status: 'skipped', attempted: 0 });
    expect(calls).toBe(0);
  }));

  it('respects the cap, waits between calls and picks up only new or changed roles next time', () => withRoles(async (db, add) => {
    await add('a', 'Data Engineer', 3);
    await add('b', 'Software Engineer', 2);
    await add('c', 'Machine Learning Engineer', 1);
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    const fetch = (async () => answer()) as unknown as typeof globalThis.fetch;

    const first = await enrichPending(db, [groq], { fetch, sleep, limit: 2, delayMs: 50, now });
    expect(first).toMatchObject({ status: 'done', pending: 3, attempted: 2, enriched: 2, failed: 0, providers: ['groq:m1'] });
    expect(waits).toEqual([50]);
    expect(await loadEnrichment(db, id('c'))).toMatchObject({ seniority: 'senior', provider: 'groq', model: 'm1' });
    expect(await loadEnrichment(db, id('a'))).toBeNull();

    expect(await enrichPending(db, [groq], { fetch, sleep: noSleep, now })).toMatchObject({ pending: 1, enriched: 1 });
    expect(await pendingEnrichment(db, now)).toEqual([]);

    await add('b', 'Software Engineer', 2, 'Build services in Go and Kubernetes.');
    expect((await pendingEnrichment(db, now)).map(p => p.jobId)).toEqual([id('b')]);
  }));

  it('stops early when the provider keeps failing and never throws', () => withRoles(async (db, add) => {
    for (const key of ['a', 'b', 'c', 'd', 'e']) await add(key, 'Data Engineer ' + key, 1);
    let calls = 0;
    const down = (async () => { calls++; return reply(503, { error: 'down' }); }) as unknown as typeof globalThis.fetch;
    const stopped = await enrichPending(db, [groq], { fetch: down, sleep: noSleep, now });
    expect(stopped).toMatchObject({ status: 'stopped', attempted: 3, failed: 3, enriched: 0 });
    expect(stopped.failures).toEqual({ 'groq: HTTP 503': 3 });
    expect(calls).toBe(3);

    // One bad answer between good ones does not stop the run.
    let n = 0;
    const flaky = (async () => (++n === 2 ? reply(200, { choices: [{ message: { content: 'nope' } }] }) : answer())) as unknown as typeof globalThis.fetch;
    const done = await enrichPending(db, [groq], { fetch: flaky, sleep: noSleep, now });
    expect(done).toMatchObject({ status: 'done', attempted: 5, enriched: 4, failed: 1, failures: { 'groq: answer did not match the schema': 1 } });
    expect((await enrichPending(db, [groq], { fetch: answer as unknown as typeof globalThis.fetch, sleep: noSleep, now })).failures).toBeUndefined();

    await db.exec('DROP TABLE job_enrichment');
    expect(await enrichPending(db, [groq], { fetch: flaky, sleep: noSleep, now })).toMatchObject({ status: 'error', attempted: 0 });
  }));

  it('drops answers for roles that pruning removes', () => withRoles(async (db, add) => {
    await add('a', 'Data Engineer', 1);
    await add('old', 'Data Engineer', 200);
    const enrichment = parseEnrichment(JSON.stringify(good))!;
    await saveEnrichment(db, id('a'), 'h', { enrichment, provider: groq });
    await saveEnrichment(db, id('old'), 'h', { enrichment, provider: groq });
    await pruneSnapshot(db, now);
    expect(await loadEnrichment(db, id('a'))).not.toBeNull();
    expect(await loadEnrichment(db, id('old'))).toBeNull();
  }));
});

describe('checking stored enrichment before publishing', () => {
  const groq = { name: 'groq' as const, model: 'm1', apiKey: 'q' };
  const roleId = `${SOURCES[0].id}:checked`;

  async function withSnapshot(test: (db: ReturnType<typeof openSQLite>['db']) => Promise<void>) {
    const { db, close } = openSQLite(':memory:');
    try {
      await ensureDB(db);
      await jobStatement(db, makeJob(SOURCES[0], { sourceJobId: 'checked', title: 'Data Engineer', applyUrl: 'https://example.com/jobs/checked', description: 'Python' }, new Date().toISOString())!).run();
      await test(db);
    } finally {
      close();
    }
  }

  it('accepts answers saved through the normal path', () => withSnapshot(async db => {
    await saveEnrichment(db, roleId, inputHash('text'), { enrichment: parseEnrichment(JSON.stringify(good))!, provider: groq });
    expect(await enrichmentProblems(db)).toEqual([]);
  }));

  it('treats a snapshot without the table as having nothing to check', () => withSnapshot(async db => {
    await db.exec('DROP TABLE job_enrichment');
    expect(await enrichmentProblems(db)).toEqual([]);
  }));

  it('reports every broken field on a hand edited row', () => withSnapshot(async db => {
    await db.prepare(`INSERT INTO job_enrichment(job_id,input_hash,provider,model,skills,seniority,normalized_title,remote,pay_min,pay_max,enriched_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(roleId, 'short', 'openai', ' ', '{"Python":1}', 'staff', 'x'.repeat(121), 'Remote', 2, 1500, 'yesterday').run();
    const problems = (await enrichmentProblems(db)).map(p => p.problem);
    expect(problems).toEqual([
      'input hash is not a sha256 hex digest',
      'unknown provider "openai"',
      'empty model name',
      'skills is not a JSON list',
      'unknown seniority "staff"',
      'unknown remote label "Remote"',
      'normalized title is missing or too long',
      'pay_min is outside 5 to 1000 per hour',
      'pay_max is outside 5 to 1000 per hour',
      'enriched_at is not a date',
    ]);
  }));

  it('flags orphaned rows, untidy skill lists and reversed pay', () => withSnapshot(async db => {
    const enrichment = parseEnrichment(JSON.stringify(good))!;
    await saveEnrichment(db, 'gone:1', inputHash('a'), { enrichment, provider: groq });
    await saveEnrichment(db, roleId, inputHash('b'), { enrichment: { ...enrichment, skills: ['Python', ' '], hourlyPayMin: 90, hourlyPayMax: 60 }, provider: groq });
    expect(await enrichmentProblems(db)).toEqual([
      { jobId: 'gone:1', problem: 'no matching role' },
      { jobId: roleId, problem: 'skills list has empty, long or non-text entries or too many entries' },
      { jobId: roleId, problem: 'pay_min is above pay_max' },
    ]);
  }));
});
