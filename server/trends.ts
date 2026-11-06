// Market trends over the public feed, computed in SQL from the snapshot.
// Everything starts from feedScopeSql, so the numbers match what the site
// lists: the same 90-day contract window, the same technical role filter
// and the same collapsing of reposted openings.
import { SOURCES } from './sources.js';
import { FEED_WINDOW_DAYS } from './policy.js';
import { feedScopeSql } from './db.js';

const DAY_MS = 86_400_000;
export const MAX_TREND_WEEKS = Math.floor(FEED_WINDOW_DAYS / 7) + 1;
// Recent skill demand is compared over two back-to-back windows of this length.
export const SKILL_WINDOW_DAYS = 28;
// Hourly rates outside this band are almost always parsing slips such as an
// annual salary labelled hourly, so they stay out of the pay figures.
const HOURLY_FLOOR = 5;
const HOURLY_CEILING = 1000;
const HOURLY_PERIODS = "('hour','hourly','hr')";

export interface TrendOptions {
  weeks?: number;
  category?: string;
  company?: string;
  skillLimit?: number;
  now?: Date;
}

export interface PayRange { currency: string; roles: number; min: number; p25: number; median: number; p75: number; max: number }
export interface MarketTrends {
  window: { from: string; to: string; weeks: number; category: string | null; company: string | null };
  totals: { roles: number; companies: number; withHourlyPay: number };
  volume: { weekStart: string; roles: number; withHourlyPay: number; avgHourlyUsd: number | null }[];
  categories: { name: string; roles: number; share: number }[];
  topSkills: { name: string; roles: number; share: number; recent: number; prior: number }[];
  pay: { overall: PayRange[]; byCategory: (PayRange & { category: string })[] };
  notes: string[];
}

const clamp = (value: number | undefined, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, Math.floor(value!))) : fallback;
const round = (value: unknown, digits = 2) => value == null ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits;

export async function marketTrends(db: D1Database, options: TrendOptions = {}): Promise<MarketTrends> {
  const now = options.now ?? new Date();
  const weeks = clamp(options.weeks, 1, MAX_TREND_WEEKS, 12);
  const skillLimit = clamp(options.skillLimit, 1, 50, 15);
  const from = new Date(now.getTime() - weeks * 7 * DAY_MS);
  const category = options.category?.trim() || null;
  const company = options.company?.trim() || null;

  const sourceIds = SOURCES.map(s => s.id);
  const filters = [feedScopeSql('j', now), `j.source_id IN (${sourceIds.map(() => '?').join(',')})`, 'julianday(j.posted_at)>=julianday(?)'];
  const params: unknown[] = [...sourceIds, from.toISOString()];
  if (category) { filters.push('j.category=?'); params.push(category); }
  if (company) { filters.push('j.company=?'); params.push(company); }

  const mid = '(coalesce(j.pay_min,j.pay_max)+coalesce(j.pay_max,j.pay_min))/2.0';
  const scope = `WITH scope AS (
    SELECT j.id, j.company, j.category, j.posted_at, j.data,
      date(j.posted_at,'-6 days','weekday 1') AS week,
      json_extract(j.data,'$.currency') AS currency,
      CASE WHEN lower(json_extract(j.data,'$.payPeriod')) IN ${HOURLY_PERIODS} AND ${mid} BETWEEN ${HOURLY_FLOOR} AND ${HOURLY_CEILING} THEN ${mid} END AS hourly
    FROM jobs j WHERE ${filters.join(' AND ')}
  )`;
  const all = async <T>(sql: string, extra: unknown[] = []) =>
    (await db.prepare(`${scope} ${sql}`).bind(...params, ...extra).all<T>()).results;

  // Nearest-rank percentiles over each currency's hourly midpoints, with
  // integer arithmetic so no math extension is needed.
  const payRanges = (partition: string) => all<any>(`, ranked AS (
      SELECT ${partition ? partition + ',' : ''} currency, hourly,
        row_number() OVER (PARTITION BY ${partition ? partition + ',' : ''} currency ORDER BY hourly) AS rn,
        count(*) OVER (PARTITION BY ${partition ? partition + ',' : ''} currency) AS n
      FROM scope WHERE hourly IS NOT NULL AND currency IS NOT NULL)
    SELECT ${partition ? partition + ',' : ''} currency, n AS roles, min(hourly) AS min, max(hourly) AS max,
      max(CASE WHEN rn=(n+3)/4 THEN hourly END) AS p25,
      max(CASE WHEN rn=(n+1)/2 THEN hourly END) AS median,
      max(CASE WHEN rn=(3*n+3)/4 THEN hourly END) AS p75
    FROM ranked GROUP BY ${partition ? partition + ',' : ''} currency ORDER BY ${partition ? partition + ',' : ''} roles DESC`);

  const recentFrom = new Date(now.getTime() - SKILL_WINDOW_DAYS * DAY_MS).toISOString();
  const priorFrom = new Date(now.getTime() - 2 * SKILL_WINDOW_DAYS * DAY_MS).toISOString();

  const [totals, volume, categories, skills, overall, byCategory] = await Promise.all([
    all<any>(`SELECT count(*) AS roles, count(DISTINCT company) AS companies, count(hourly) AS paid FROM scope`),
    all<any>(`SELECT week, count(*) AS roles, count(hourly) AS paid, avg(CASE WHEN currency='USD' THEN hourly END) AS usd FROM scope GROUP BY week ORDER BY week`),
    all<any>(`SELECT category AS name, count(*) AS roles FROM scope GROUP BY category ORDER BY roles DESC, name`),
    all<any>(`SELECT s.value AS name, count(DISTINCT scope.id) AS roles,
        count(DISTINCT CASE WHEN julianday(scope.posted_at)>=julianday(?) THEN scope.id END) AS recent,
        count(DISTINCT CASE WHEN julianday(scope.posted_at)>=julianday(?) AND julianday(scope.posted_at)<julianday(?) THEN scope.id END) AS prior
      FROM scope, json_each(json_extract(scope.data,'$.skills')) s
      WHERE trim(s.value)<>'' GROUP BY s.value ORDER BY roles DESC, name LIMIT ?`, [recentFrom, priorFrom, recentFrom, skillLimit]),
    payRanges(''),
    payRanges('category'),
  ]);

  const roles = Number(totals[0]?.roles ?? 0);
  const share = (count: number) => roles ? round(count / roles, 3)! : 0;
  const range = (r: any): PayRange => ({ currency: r.currency, roles: Number(r.roles), min: round(r.min)!, p25: round(r.p25)!, median: round(r.median)!, p75: round(r.p75)!, max: round(r.max)! });

  return {
    window: { from: from.toISOString(), to: now.toISOString(), weeks, category, company },
    totals: { roles, companies: Number(totals[0]?.companies ?? 0), withHourlyPay: Number(totals[0]?.paid ?? 0) },
    volume: volume.map(r => ({ weekStart: r.week, roles: Number(r.roles), withHourlyPay: Number(r.paid), avgHourlyUsd: round(r.usd) })),
    categories: categories.map(r => ({ name: r.name, roles: Number(r.roles), share: share(Number(r.roles)) })),
    topSkills: skills.map(r => ({ name: r.name, roles: Number(r.roles), share: share(Number(r.roles)), recent: Number(r.recent), prior: Number(r.prior) })),
    pay: { overall: overall.map(range), byCategory: byCategory.map(r => ({ category: r.category, ...range(r) })) },
    notes: [
      'Volume is grouped by the Monday that starts each posting week, so the first and last weeks can be partial.',
      `Pay figures use the midpoint of each listed hourly range, per currency. Only roles that state an hourly rate between ${HOURLY_FLOOR} and ${HOURLY_CEILING} count.`,
      `Skill "recent" counts roles posted in the last ${SKILL_WINDOW_DAYS} days and "prior" the ${SKILL_WINDOW_DAYS} days before that.`,
    ],
  };
}
