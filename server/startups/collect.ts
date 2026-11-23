// StartupAtlas collection and reads.
//
// StartupAtlas lists every open role at a curated set of fast-growing
// startups. It lives in its own tables beside the contract feed, so the
// contract feed, its counts and its MCP tools never see these roles.
import seed from './companies.json' with { type: 'json' };
import { ATS_LIST, boardsInHtml, readBoard, type Ats, type Board, type BoardRead, type Get, type StartupRole } from './boards.js';
import { robotsAllowed } from '../adapters.js';
import type { Database } from '../database.js';

export interface StartupCompany {
  id: string;
  name: string;
  focus: string;
  location: string;
  careersUrl?: string;
  fastestRank?: number;
  tier?: string;
  breakoutFocus?: string;
  ats?: Ats;
  board?: string;
  // Set when the company's name is shared with another firm that has a board
  // under the same slug, so a guess would list the wrong company's roles.
  noGuess?: boolean;
}
export const STARTUP_COMPANIES = seed.companies as StartupCompany[];

export const STARTUP_DDL = [
  'CREATE TABLE IF NOT EXISTS startup_companies (id TEXT PRIMARY KEY,ats TEXT,board TEXT,status TEXT NOT NULL DEFAULT \'pending\',message TEXT,role_count INTEGER NOT NULL DEFAULT 0,checked_at TEXT,resolved_at TEXT)',
  'CREATE TABLE IF NOT EXISTS startup_jobs (id TEXT PRIMARY KEY,company_id TEXT NOT NULL,title TEXT NOT NULL,team TEXT,location TEXT NOT NULL,remote INTEGER NOT NULL DEFAULT 0,employment_type TEXT,posted_at TEXT,url TEXT NOT NULL,pay_min REAL,pay_max REAL,currency TEXT,pay_interval TEXT,summary TEXT NOT NULL DEFAULT \'\',first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS startup_jobs_company ON startup_jobs(company_id)',
];
export async function ensureStartupTables(db: Database): Promise<void> {
  await db.batch(STARTUP_DDL.map(s => db.prepare(s)));
}
export async function hasStartupTables(db: Database): Promise<boolean> {
  const row = await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('startup_companies','startup_jobs')").first<{ n: number }>();
  return row?.n === 2;
}

const USER_AGENT = 'ContractAtlas/1.0 (public job aggregator; StartupAtlas)';
export const defaultGet: Get = async (url: string) => {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,application/rss+xml,text/html;q=0.9' }, signal: AbortSignal.timeout(12_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 12_000_000) throw new Error('Response exceeded the size limit.');
  return body;
};

// Words that do not identify a company on their own.
const GENERIC = new Set(['ai', 'labs', 'lab', 'inc', 'co', 'technologies', 'industries', 'intelligence', 'security', 'software', 'health', 'the', 'company', 'research', 'robotics', 'bio', 'nuclear', 'medical', 'space', 'atomics', 'aerospace']);
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[·.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Board slugs worth trying when a company publishes no board link.
export function guessSlugs(company: StartupCompany): string[] {
  const key = nameKey(company.name);
  const out = new Set<string>([key.replace(/ /g, ''), key.replace(/ /g, '-')]);
  const core = key.split(' ').filter(w => !GENERIC.has(w)).join('');
  if (core.length >= 4) out.add(core);
  if (company.careersUrl) {
    try {
      const host = new URL(company.careersUrl).hostname.replace(/^(www|careers|jobs)\./, '');
      const stem = host.split('.')[0];
      if (stem && stem.length >= 3) out.add(stem);
    } catch { /* ignore */ }
  }
  return [...out].filter(s => s.length >= 2);
}
// A guessed board is only trusted when it clearly belongs to the company,
// which stops a generic slug such as "open" or "base" from pulling in
// another firm's roles.
export function boardMatches(company: StartupCompany, read: BoardRead): boolean {
  const key = nameKey(company.name);
  const haystack = nameKey(`${read.boardName ?? ''} ${read.text.slice(0, 200_000)}`);
  if (!haystack) return false;
  const wordsIn = (phrase: string) => new RegExp(`(^| )${phrase.replace(/ /g, ' ?')}( |$)`).test(haystack);
  if (read.boardName && nameKey(read.boardName).includes(key)) return true;
  if (key.length < 5 || !key.includes(' ') && GENERIC.has(key)) return false;
  if (!read.roles.length) return false;
  // The company name has to appear in a good share of the role descriptions.
  const mentions = (read.text.match(new RegExp(key.replace(/ /g, '\\W?'), 'gi')) ?? []).length;
  return wordsIn(key) && mentions >= Math.min(3, read.roles.length);
}

async function robotsOk(url: string, get: Get): Promise<boolean> {
  const u = new URL(url);
  try {
    const robots = await get(`${u.origin}/robots.txt`);
    return robots.includes('<html') || robotsAllowed(robots, u.pathname);
  } catch {
    return true;
  }
}

export interface Resolution { board: Board | null; read: BoardRead | null; status: 'ok' | 'no-board' | 'blocked' | 'error'; message: string }

// Works out which public board a company uses and reads it. The order is the
// board named in the seed, the board already stored from an earlier run,
// board links on the company's careers page, and finally guessed slugs that
// must pass boardMatches.
export async function resolveCompany(company: StartupCompany, get: Get, stored?: Board | null): Promise<Resolution> {
  const tried = new Set<string>();
  const attempt = async (board: Board) => {
    const key = `${board.ats}:${board.board.toLowerCase()}`;
    if (tried.has(key)) return null;
    tried.add(key);
    try { return await readBoard(board, get); } catch { return null; }
  };
  for (const board of [company.ats && company.board ? { ats: company.ats, board: company.board } : null, stored ?? null]) {
    if (!board) continue;
    const read = await attempt(board);
    if (read) return { board, read, status: 'ok', message: `${read.roles.length} open roles on ${board.ats}` };
  }
  let blocked = false;
  if (company.careersUrl) {
    if (!(await robotsOk(company.careersUrl, get))) blocked = true;
    else {
      try {
        const html = await get(company.careersUrl);
        const links = boardsInHtml(html).sort((a, b) => ATS_LIST.indexOf(a.ats) - ATS_LIST.indexOf(b.ats));
        for (const board of links) {
          const read = await attempt(board);
          if (read && (read.roles.length || links.length === 1)) return { board, read, status: 'ok', message: `${read.roles.length} open roles on ${board.ats}, linked from the careers page` };
        }
      } catch { /* fall through to guesses */ }
    }
  }
  for (const slug of company.noGuess ? [] : guessSlugs(company)) {
    for (const ats of ['ashby', 'greenhouse', 'lever'] as const) {
      const board = { ats, board: slug };
      const read = await attempt(board);
      if (read && boardMatches(company, read)) return { board, read, status: 'ok', message: `${read.roles.length} open roles on ${ats}` };
    }
  }
  if (blocked) return { board: null, read: null, status: 'blocked', message: 'The careers page disallows automated reading and no public board was found.' };
  return { board: null, read: null, status: 'no-board', message: company.careersUrl ? 'No public job board was found on the careers page.' : 'No careers page or public job board is known yet.' };
}

const DAY = 86_400_000;
export interface StartupRunResult { companies: number; withBoards: number; roles: number; checked: number; failed: number; durationMs: number }

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

export async function saveRoles(db: Database, companyId: string, roles: StartupRole[], now: string): Promise<void> {
  const existing = new Map((await db.prepare('SELECT id,first_seen_at FROM startup_jobs WHERE company_id=?').bind(companyId).all<{ id: string; first_seen_at: string }>()).results.map(r => [r.id, r.first_seen_at]));
  const unique = [...new Map(roles.map(r => [r.id, r])).values()];
  const statements = [db.prepare('DELETE FROM startup_jobs WHERE company_id=?').bind(companyId)];
  for (const r of unique) {
    statements.push(db.prepare(`INSERT INTO startup_jobs(id,company_id,title,team,location,remote,employment_type,posted_at,url,pay_min,pay_max,currency,pay_interval,summary,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(r.id, companyId, r.title, r.team, r.location, r.remote ? 1 : 0, r.employmentType, r.postedAt, r.url, r.payMin, r.payMax, r.currency, r.payInterval, r.summary, existing.get(r.id) ?? now, now));
  }
  await db.batch(statements);
}

// Refreshes every company. A company whose board fails keeps its previous
// roles until the next run, and companies with no known board are looked up
// again at most once a day so the refresh stays quick.
export async function collectStartups(db: Database, options: { get?: Get; now?: Date; companies?: StartupCompany[]; concurrency?: number } = {}): Promise<StartupRunResult> {
  const started = Date.now();
  const get = options.get ?? defaultGet;
  const now = options.now ?? new Date();
  const companies = options.companies ?? STARTUP_COMPANIES;
  await ensureStartupTables(db);
  const ids = companies.map(c => c.id);
  await db.prepare(`DELETE FROM startup_jobs WHERE company_id NOT IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  await db.prepare(`DELETE FROM startup_companies WHERE id NOT IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  const stored = new Map((await db.prepare('SELECT * FROM startup_companies').all<any>()).results.map(r => [r.id, r]));
  let checked = 0, failed = 0;
  await pool(companies, options.concurrency ?? 8, async company => {
    const prior = stored.get(company.id);
    // A company marked noGuess ignores a board stored by an earlier guess.
    const priorBoard = prior?.ats && prior?.board && !company.noGuess ? { ats: prior.ats as Ats, board: prior.board as string } : null;
    if (!prior?.ats && !company.board && prior?.checked_at && now.getTime() - Date.parse(prior.checked_at) < DAY) return;
    checked++;
    const at = now.toISOString();
    let result: Resolution;
    try { result = await resolveCompany(company, get, priorBoard); } catch (error) {
      result = { board: null, read: null, status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === 'ok' && result.read && result.board) {
      await saveRoles(db, company.id, result.read.roles, at);
    } else if (!priorBoard) {
      await db.prepare('DELETE FROM startup_jobs WHERE company_id=?').bind(company.id).run();
    } else {
      // A board that answered before and fails now keeps its roles for a day.
      failed++;
      if (prior?.resolved_at && now.getTime() - Date.parse(prior.resolved_at) > DAY) await db.prepare('DELETE FROM startup_jobs WHERE company_id=?').bind(company.id).run();
      else {
        await db.prepare('UPDATE startup_companies SET status=?,message=?,checked_at=? WHERE id=?').bind('error', `The ${priorBoard.ats} board did not answer this time; earlier roles are kept for now.`, at, company.id).run();
        return;
      }
    }
    const count = (await db.prepare('SELECT count(*) AS n FROM startup_jobs WHERE company_id=?').bind(company.id).first<{ n: number }>())?.n ?? 0;
    await db.prepare(`INSERT INTO startup_companies(id,ats,board,status,message,role_count,checked_at,resolved_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ats=excluded.ats,board=excluded.board,status=excluded.status,message=excluded.message,role_count=excluded.role_count,checked_at=excluded.checked_at,resolved_at=COALESCE(excluded.resolved_at,startup_companies.resolved_at)`)
      .bind(company.id, result.board?.ats ?? null, result.board?.board ?? null, result.status, result.message, count, at, result.status === 'ok' ? at : null).run();
  });
  const totals = await db.prepare("SELECT (SELECT count(*) FROM startup_jobs) AS roles,(SELECT count(*) FROM startup_companies WHERE ats IS NOT NULL) AS boards").first<{ roles: number; boards: number }>();
  return { companies: companies.length, withBoards: totals?.boards ?? 0, roles: totals?.roles ?? 0, checked, failed, durationMs: Date.now() - started };
}

// ---- Reads for the site ----

export interface StartupCompanyView extends Omit<StartupCompany, 'board' | 'ats' | 'noGuess'> {
  ats: Ats | null;
  board: string | null;
  boardUrl: string | null;
  status: string;
  message: string | null;
  roleCount: number;
  remoteCount: number;
  checkedAt: string | null;
}
export interface StartupJobView {
  id: string; companyId: string; title: string; team: string | null; location: string; remote: boolean;
  employmentType: string | null; postedAt: string | null; firstSeenAt: string; url: string;
  payMin: number | null; payMax: number | null; currency: string | null; payInterval: string | null;
}
export interface StartupOverview { companies: number; withBoards: number; roles: number; remoteRoles: number; newThisWeek: number; updatedAt: string | null }

function publicBoardUrl(ats: Ats | null, board: string | null): string | null {
  if (!ats || !board) return null;
  const b = encodeURIComponent(board);
  return {
    ashby: `https://jobs.ashbyhq.com/${b}`, greenhouse: `https://job-boards.greenhouse.io/${b}`, lever: `https://jobs.lever.co/${b}`,
    workable: `https://apply.workable.com/${b}/`, gem: `https://jobs.gem.com/${b}`, teamtailor: `https://${board}.teamtailor.com/jobs`,
  }[ats];
}

export async function startupCompanies(db: Database): Promise<StartupCompanyView[]> {
  const ready = await hasStartupTables(db);
  const rows = ready ? new Map((await db.prepare(`SELECT c.*, (SELECT count(*) FROM startup_jobs j WHERE j.company_id=c.id AND j.remote=1) AS remote_count FROM startup_companies c`).all<any>()).results.map(r => [r.id, r])) : new Map();
  return STARTUP_COMPANIES.map(({ noGuess: _skip, ...c }) => {
    const r = rows.get(c.id);
    const ats = (r?.ats ?? null) as Ats | null, board = r?.board ?? null;
    return {
      ...c, ats, board, boardUrl: publicBoardUrl(ats, board),
      status: r?.status ?? 'pending', message: r?.message ?? null, roleCount: r?.role_count ?? 0, remoteCount: r?.remote_count ?? 0, checkedAt: r?.checked_at ?? null,
    };
  });
}

export async function startupJobs(db: Database): Promise<StartupJobView[]> {
  if (!(await hasStartupTables(db))) return [];
  // The stored snippet stays out of the response, since the page links to
  // each posting and every byte here is sent to phones too.
  const rows = (await db.prepare('SELECT id,company_id,title,team,location,remote,employment_type,posted_at,first_seen_at,url,pay_min,pay_max,currency,pay_interval FROM startup_jobs ORDER BY COALESCE(posted_at,first_seen_at) DESC, id').all<any>()).results;
  return rows.map(r => ({
    id: r.id, companyId: r.company_id, title: r.title, team: r.team, location: r.location, remote: r.remote === 1,
    employmentType: r.employment_type, postedAt: r.posted_at, firstSeenAt: r.first_seen_at, url: r.url,
    payMin: r.pay_min, payMax: r.pay_max, currency: r.currency, payInterval: r.pay_interval,
  }));
}

export async function startupOverview(db: Database, now = new Date()): Promise<StartupOverview> {
  if (!(await hasStartupTables(db))) return { companies: STARTUP_COMPANIES.length, withBoards: 0, roles: 0, remoteRoles: 0, newThisWeek: 0, updatedAt: null };
  const week = new Date(now.getTime() - 7 * DAY).toISOString();
  const r = await db.prepare(`SELECT (SELECT count(*) FROM startup_jobs) AS roles,(SELECT count(*) FROM startup_jobs WHERE remote=1) AS remote,
    (SELECT count(*) FROM startup_jobs WHERE COALESCE(posted_at,first_seen_at)>=?) AS fresh,(SELECT count(*) FROM startup_companies WHERE ats IS NOT NULL) AS boards,
    (SELECT max(checked_at) FROM startup_companies) AS updated`).bind(week).first<any>();
  return { companies: STARTUP_COMPANIES.length, withBoards: r?.boards ?? 0, roles: r?.roles ?? 0, remoteRoles: r?.remote ?? 0, newThisWeek: r?.fresh ?? 0, updatedAt: r?.updated ?? null };
}
