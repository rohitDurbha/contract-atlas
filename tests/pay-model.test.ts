import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, jobStatement } from '../server/db';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';
import { estimatePay, featureKeys, isPayModel, locationParts, MIN_TRAINING_ROLES, titleWords, trainCurrency, trainPayModel } from '../server/pay-model';

const now = new Date('2026-11-06T12:00:00.000Z');

describe('pay model features', () => {
  it('splits titles into meaningful words', () => {
    expect(titleWords('Sr. Data Engineer (Contract, W2) - Remote')).toEqual(['sr', 'data', 'engineer']);
    expect(titleWords('C# / .NET Developer II')).toEqual(['c#', 'net', 'developer', 'ii']);
  });

  it('reads the region code and city from a location', () => {
    expect(locationParts('San Antonio, TX, United States')).toEqual({ city: 'san antonio', region: 'TX' });
    expect(locationParts('Remote, CA')).toEqual({ city: null, region: 'CA' });
    expect(locationParts('London')).toEqual({ city: null, region: null });
    expect(locationParts(null)).toEqual({ city: null, region: null });
  });

  it('builds one key per signal and skips unspecified work modes', () => {
    expect(featureKeys({ title: 'Data Engineer', skills: ['Python', 'python'], category: 'Data & Analytics', location: 'Austin, TX', country: 'us', workMode: 'Unspecified', company: 'Meta' }))
      .toEqual(['title:data', 'title:engineer', 'skill:python', 'category:Data & Analytics', 'region:TX', 'city:austin', 'country:US', 'company:Meta']);
  });
});

// Synthetic market where seniority adds about 30% and Washington about 20%.
function market(count: number) {
  const examples = [];
  for (let i = 0; i < count; i++) {
    const senior = i % 2 === 0, wa = i % 3 === 0, noise = ((i * 7) % 11 - 5) / 100;
    const pay = 50 * (senior ? 1.3 : 1) * (wa ? 1.2 : 1) * (1 + noise);
    // Developer versus engineer and Python versus Java carry no pay signal.
    const keys = featureKeys({ title: `${senior ? 'Senior ' : ''}Software ${i % 5 < 2 ? 'Developer' : 'Engineer'}`, location: wa ? 'Seattle, WA' : 'Austin, TX', skills: [i % 7 < 3 ? 'Java' : 'Python'] });
    examples.push({ id: 'role-' + i, keys, logPay: Math.log(pay) });
  }
  return examples;
}

describe('pay model training', () => {
  it('needs enough paid roles before it fits a currency', () => {
    expect(trainCurrency('USD', market(MIN_TRAINING_ROLES - 1))).toBeNull();
    expect(trainCurrency('USD', market(MIN_TRAINING_ROLES))).not.toBeNull();
  });

  it('learns the direction and rough size of each signal', () => {
    const m = trainCurrency('USD', market(200))!;
    expect(m.roles).toBe(200);
    expect(Math.exp(m.weights['title:senior'])).toBeGreaterThan(1.2);
    // Seattle always means WA here, so the two keys share the 20% between them.
    expect(Math.exp(m.weights['region:WA'] + m.weights['city:seattle'] - m.weights['region:TX'] - m.weights['city:austin'])).toBeGreaterThan(1.15);
    expect(Math.abs(m.weights['skill:java'])).toBeLessThan(0.03);
    expect(m.holdout.roles).toBeGreaterThan(20);
    expect(m.holdout.medianAbsPctError).toBeLessThan(0.08);
    expect(m.residual.p25).toBeLessThanOrEqual(0);
    expect(m.residual.p75).toBeGreaterThanOrEqual(0);
  });

  it('returns a labelled range with the drivers behind it', () => {
    const model = { version: 1, trainedAt: now.toISOString(), windowDays: 90, features: { minSupport: 5, maxFeatures: 600, lambda: 4 }, currencies: { USD: trainCurrency('USD', market(200))! } };
    expect(isPayModel(model)).toBe(true);
    const senior = estimatePay(model, { title: 'Senior Software Engineer', location: 'Seattle, WA', skills: ['Python', 'Rust'] })!;
    const junior = estimatePay(model, { title: 'Software Engineer', location: 'Austin, TX' })!;
    expect(senior.mid).toBeGreaterThan(junior.mid * 1.3);
    expect(senior.mid).toBeGreaterThan(70);
    expect(senior.mid).toBeLessThan(85);
    expect(senior.low).toBeLessThanOrEqual(senior.mid);
    expect(senior.high).toBeGreaterThanOrEqual(senior.mid);
    expect(senior.label).toMatch(/^Estimate only/);
    expect(senior.drivers.map(d => d.feature)).toContain('title senior');
    expect(senior.unmatched).toContain('skill rust');
    expect(senior.confidence).toBe('medium');
    expect(estimatePay(model, { title: 'Engineer' }, 'EUR')).toBeNull();
  });
});

describe('pay model from the snapshot', () => {
  const sqlite = openSQLite(':memory:');

  beforeAll(async () => {
    await ensureDB(sqlite.db);
    await sqlite.db.prepare('DELETE FROM jobs').run();
    const posted = new Date(now.getTime() - 86_400_000).toISOString();
    const add = (id: string, title: string, location: string, extra: Record<string, unknown>) =>
      jobStatement(sqlite.db, makeJob(SOURCES[0], { sourceJobId: id, title, location, applyUrl: 'https://example.com/jobs/' + id, postedAt: posted, description: 'Contract role.', ...extra }, now.toISOString())!).run();
    for (let i = 0; i < 60; i++) {
      const senior = i % 2 === 0;
      await add('usd-' + i, `${senior ? 'Senior ' : ''}Data Engineer ${i}`, 'Austin, TX', { payMin: senior ? 80 : 60, payMax: senior ? 90 : 70, payPeriod: 'hour', currency: 'USD', skills: ['SQL'] });
    }
    // None of these may reach the training set. A repost of usd-0, an annual
    // salary, an hourly typo that is really a salary and a CAD market too small to model.
    await add('repost', 'Senior Data Engineer 0', 'Austin, TX', { postedAt: new Date(now.getTime() - 5 * 86_400_000).toISOString(), payMin: 500, payMax: 500, payPeriod: 'hour', currency: 'USD' });
    await add('salary', 'Senior Data Engineer', 'Austin, TX', { payMin: 150000, payMax: 170000, payPeriod: 'year', currency: 'USD' });
    await add('typo', 'Data Engineer', 'Austin, TX', { payMin: 120000, payMax: 130000, payPeriod: 'hour', currency: 'USD' });
    for (let i = 0; i < 5; i++) await add('cad-' + i, 'Data Engineer', 'Calgary, AB', { payMin: 70, payPeriod: 'hourly', currency: 'CAD' });
  });
  afterAll(() => sqlite.close());

  it('trains on listed hourly roles through the feed scope', async () => {
    const model = await trainPayModel(sqlite.db, now);
    expect(isPayModel(model)).toBe(true);
    expect(Object.keys(model.currencies)).toEqual(['USD']);
    expect(model.currencies.USD.roles).toBe(60);
    const estimate = estimatePay(model, { title: 'Senior Data Engineer', location: 'Austin, TX', skills: ['SQL'] })!;
    expect(estimate.mid).toBeGreaterThan(75);
    expect(estimate.mid).toBeLessThan(95);
    // The model survives a round trip through JSON, as it does on disk.
    expect(estimatePay(JSON.parse(JSON.stringify(model)), { title: 'Senior Data Engineer' })!.mid).toBeCloseTo(estimatePay(model, { title: 'Senior Data Engineer' })!.mid, 5);
  });
});
