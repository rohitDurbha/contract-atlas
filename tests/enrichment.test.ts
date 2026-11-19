import { describe, it, expect } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB } from '../server/db';
import {
  ENRICHMENT_MODELS, enrichmentInput, inputHash, loadEnrichment, parseEnrichment, providersFromEnv, requestEnrichment, saveEnrichment,
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
