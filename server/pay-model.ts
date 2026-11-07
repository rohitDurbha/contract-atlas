// Hourly pay estimates for roles that do not list a rate.
//
// The refresh workflow fits a ridge regression on the log of each listed
// hourly midpoint, one model per currency, using simple sparse features
// (title words, skills, category, location, work mode and company). Only the
// coefficients are saved, as JSON next to the snapshot, so answering a request
// is a dictionary lookup and a sum with no runtime training or AI cost.
import { FEED_WINDOW_DAYS } from './policy.js';
import { feedScopeSql } from './db.js';
import { SOURCES } from './sources.js';

export const PAY_MODEL_VERSION = 1;
// Same sanity band as the market trends pay figures.
const HOURLY_FLOOR = 5;
const HOURLY_CEILING = 1000;
const HOURLY_PERIODS = "('hour','hourly','hr')";
// A currency needs at least this many paid roles before it gets a model.
export const MIN_TRAINING_ROLES = 40;
// A feature must appear in this many paid roles to earn a coefficient, which
// keeps one-off words from memorising a single posting.
const MIN_SUPPORT = 5;
const MAX_FEATURES = 600;
const RIDGE_LAMBDA = 4;
// Roughly one in five roles is held out to report honest error figures before
// the final model is refitted on every role.
const HOLDOUT_BUCKETS = 5;

const STOP_WORDS = new Set(['and', 'or', 'of', 'the', 'for', 'to', 'in', 'on', 'at', 'with', 'a', 'an', 'contract', 'contractor', 'temp', 'temporary', 'remote', 'hybrid', 'onsite', 'only', 'local', 'w2', 'c2c', 'hr', 'hour', 'per']);

export interface PayFeatures {
  title: string;
  skills?: string[];
  category?: string | null;
  location?: string | null;
  country?: string | null;
  workMode?: string | null;
  company?: string | null;
}

export interface CurrencyModel {
  currency: string;
  roles: number;
  intercept: number;
  weights: Record<string, number>;
  // Quantiles of log(actual / predicted) on held-out roles, used for the range.
  residual: { p10: number; p25: number; p75: number; p90: number };
  holdout: { roles: number; medianAbsError: number; medianAbsPctError: number };
}

export interface PayModel {
  version: number;
  trainedAt: string;
  windowDays: number;
  features: { minSupport: number; maxFeatures: number; lambda: number };
  currencies: Record<string, CurrencyModel>;
}

export interface PayEstimate {
  currency: string;
  period: 'hour';
  low: number;
  mid: number;
  high: number;
  label: string;
  confidence: 'low' | 'medium';
  drivers: { feature: string; effect: string }[];
  unmatched: string[];
  basis: { trainedAt: string; trainingRoles: number; holdoutRoles: number; holdoutMedianAbsError: number; holdoutMedianAbsPctError: number };
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();

export function titleWords(title: string): string[] {
  const words = slug(title).split(' ').map(w => w.replace(/^\.+|\.+$/g, ''));
  return [...new Set(words.filter(w => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)))];
}

// US and Canadian locations usually end in a two-letter region code, as in
// "San Antonio, TX, United States". That region is a stronger pay signal than
// the city, which is kept too for the large metros that pass the support bar.
export function locationParts(location: string | null | undefined): { city: string | null; region: string | null } {
  const parts = (location ?? '').split(',').map(p => p.trim()).filter(Boolean);
  const region = parts.slice(1).find(p => /^[A-Z]{2}$/.test(p)) ?? null;
  const city = parts.length > 1 && !/remote/i.test(parts[0]) ? slug(parts[0]) : null;
  return { city: city || null, region };
}

export function featureKeys(input: PayFeatures): string[] {
  const keys = titleWords(input.title).map(w => 'title:' + w);
  for (const skill of input.skills ?? []) if (slug(skill)) keys.push('skill:' + slug(skill));
  if (input.category) keys.push('category:' + input.category);
  const { city, region } = locationParts(input.location);
  if (region) keys.push('region:' + region);
  if (city) keys.push('city:' + city);
  if (input.country) keys.push('country:' + input.country.toUpperCase());
  if (input.workMode && input.workMode !== 'Unspecified') keys.push('mode:' + input.workMode);
  if (input.company) keys.push('company:' + input.company);
  return [...new Set(keys)];
}

const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, low = Math.floor(pos), high = Math.ceil(pos);
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
};
const median = (values: number[]) => quantile([...values].sort((a, b) => a - b), 0.5);
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

// Stable bucket from the role id so the same roles are always held out.
function bucket(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % HOLDOUT_BUCKETS;
}

// Solve (A + lambda I) w = b with a Cholesky factorisation. A is X'X for the
// centred design, so it is symmetric and the ridge term makes it positive definite.
function ridgeSolve(a: Float64Array, b: Float64Array, n: number, lambda: number): Float64Array {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j] + (i === j ? lambda : 0);
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k];
      l[i * n + j] = i === j ? Math.sqrt(sum) : sum / l[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * y[k];
    y[i] = sum / l[i * n + i];
  }
  const w = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * w[k];
    w[i] = sum / l[i * n + i];
  }
  return w;
}

interface Example { id: string; keys: string[]; logPay: number }

function fit(examples: Example[]): { intercept: number; weights: Record<string, number> } {
  const support = new Map<string, number>();
  for (const e of examples) for (const k of e.keys) support.set(k, (support.get(k) ?? 0) + 1);
  const vocab = [...support].filter(([, n]) => n >= MIN_SUPPORT && n < examples.length)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_FEATURES).map(([k]) => k);
  const index = new Map(vocab.map((k, i) => [k, i]));
  const n = vocab.length, rows = examples.length;
  const yMean = examples.reduce((s, e) => s + e.logPay, 0) / rows;
  if (!n) return { intercept: yMean, weights: {} };
  // Binary features, centred so the intercept stays unpenalised.
  const means = new Float64Array(n);
  const active = examples.map(e => e.keys.map(k => index.get(k)).filter((i): i is number => i !== undefined));
  for (const idx of active) for (const i of idx) means[i] += 1 / rows;
  const a = new Float64Array(n * n), b = new Float64Array(n);
  for (let r = 0; r < rows; r++) {
    const idx = active[r], y = examples[r].logPay - yMean;
    for (const i of idx) { b[i] += y; for (const j of idx) a[i * n + j] += 1; }
  }
  // X'X for centred columns is the raw co-occurrence count minus rows * mean_i * mean_j.
  // The y term needs no correction because y is centred too.
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) a[i * n + j] -= rows * means[i] * means[j];
  const w = ridgeSolve(a, b, n, RIDGE_LAMBDA);
  let intercept = yMean;
  const weights: Record<string, number> = {};
  // Every feature in the vocabulary is kept, even with a near-zero weight, so a
  // caller can tell a known but neutral signal from one the model never saw.
  for (let i = 0; i < n; i++) { intercept -= w[i] * means[i]; weights[vocab[i]] = round(w[i]); }
  return { intercept: round(intercept, 6), weights };
}

const score = (m: { intercept: number; weights: Record<string, number> }, keys: string[]) =>
  keys.reduce((s, k) => s + (m.weights[k] ?? 0), m.intercept);

export function trainCurrency(currency: string, examples: Example[]): CurrencyModel | null {
  if (examples.length < MIN_TRAINING_ROLES) return null;
  const train = examples.filter(e => bucket(e.id) !== 0), test = examples.filter(e => bucket(e.id) === 0);
  const probe = fit(train.length >= MIN_TRAINING_ROLES ? train : examples);
  const evalSet = test.length ? test : examples;
  const residuals = evalSet.map(e => e.logPay - score(probe, e.keys)).sort((a, b) => a - b);
  const absErrors = evalSet.map(e => Math.abs(Math.exp(e.logPay) - Math.exp(score(probe, e.keys))));
  const pctErrors = evalSet.map(e => Math.abs(Math.exp(score(probe, e.keys)) / Math.exp(e.logPay) - 1));
  const final = fit(examples);
  return {
    currency, roles: examples.length, ...final,
    residual: { p10: round(quantile(residuals, 0.1)), p25: round(quantile(residuals, 0.25)), p75: round(quantile(residuals, 0.75)), p90: round(quantile(residuals, 0.9)) },
    holdout: { roles: evalSet.length, medianAbsError: round(median(absErrors), 2), medianAbsPctError: round(median(pctErrors), 3) },
  };
}

// Reads every listed role with a sane hourly rate through the same feed scope
// the site uses, then fits one model per currency that has enough data.
export async function trainPayModel(db: D1Database, now = new Date()): Promise<PayModel> {
  const sourceIds = SOURCES.map(s => s.id);
  const mid = '(coalesce(pay_min,pay_max)+coalesce(pay_max,pay_min))/2.0';
  const rows = (await db.prepare(`SELECT id, company, title, location, country, work_mode, category,
      json_extract(data,'$.skills') AS skills, json_extract(data,'$.currency') AS currency, ${mid} AS hourly
    FROM jobs WHERE ${feedScopeSql('', now)} AND source_id IN (${sourceIds.map(() => '?').join(',')})
      AND lower(json_extract(data,'$.payPeriod')) IN ${HOURLY_PERIODS} AND json_extract(data,'$.currency') IS NOT NULL
      AND ${mid} BETWEEN ${HOURLY_FLOOR} AND ${HOURLY_CEILING}
    ORDER BY id`).bind(...sourceIds).all<any>()).results;
  const byCurrency = new Map<string, Example[]>();
  for (const r of rows) {
    let skills: string[] = [];
    try { skills = JSON.parse(r.skills ?? '[]'); } catch { /* malformed skills are ignored */ }
    const keys = featureKeys({ title: r.title, skills, category: r.category, location: r.location, country: r.country, workMode: r.work_mode, company: r.company });
    const list = byCurrency.get(r.currency) ?? [];
    list.push({ id: r.id, keys, logPay: Math.log(Number(r.hourly)) });
    byCurrency.set(r.currency, list);
  }
  const currencies: Record<string, CurrencyModel> = {};
  for (const [currency, examples] of [...byCurrency].sort()) {
    const model = trainCurrency(currency, examples);
    if (model) currencies[currency] = model;
  }
  return { version: PAY_MODEL_VERSION, trainedAt: now.toISOString(), windowDays: FEED_WINDOW_DAYS, features: { minSupport: MIN_SUPPORT, maxFeatures: MAX_FEATURES, lambda: RIDGE_LAMBDA }, currencies };
}

const money = (value: number) => Math.round(value * 100) / 100;
const pretty = (key: string) => key.replace(/^(\w+):/, (_, kind) => kind + ' ');

export function estimatePay(model: PayModel, input: PayFeatures, currency = 'USD'): PayEstimate | null {
  const m = model.currencies[currency];
  if (!m) return null;
  const keys = featureKeys(input);
  const matched = keys.filter(k => k in m.weights);
  const log = score(m, keys);
  const drivers = matched.map(k => ({ key: k, w: m.weights[k] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 6)
    .map(({ key, w }) => ({ feature: pretty(key), effect: `${w >= 0 ? '+' : ''}${Math.round((Math.exp(w) - 1) * 100)}%` }));
  // Few matched features means the estimate leans on the overall average.
  const confidence = matched.filter(k => k.startsWith('title:') || k.startsWith('skill:')).length >= 2 ? 'medium' : 'low';
  return {
    currency, period: 'hour',
    low: money(Math.exp(log + m.residual.p25)), mid: money(Math.exp(log)), high: money(Math.exp(log + m.residual.p75)),
    label: `Estimate only. Modelled from ${m.roles} listed ${currency} hourly rates in the last ${model.windowDays} days. The range is where about half of similar roles landed, not a quote.`,
    confidence, drivers,
    unmatched: keys.filter(k => !(k in m.weights)).map(pretty),
    basis: { trainedAt: model.trainedAt, trainingRoles: m.roles, holdoutRoles: m.holdout.roles, holdoutMedianAbsError: m.holdout.medianAbsError, holdoutMedianAbsPctError: m.holdout.medianAbsPctError },
  };
}

export function isPayModel(value: unknown): value is PayModel {
  const v = value as PayModel;
  return !!v && v.version === PAY_MODEL_VERSION && typeof v.trainedAt === 'string' && !!v.currencies && typeof v.currencies === 'object';
}
