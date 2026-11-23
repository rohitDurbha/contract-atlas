// Public job board readers for StartupAtlas.
//
// Startups mostly publish their openings through hosted applicant tracking
// systems that expose a public, read-only posting API meant for embedding on
// careers pages. Each reader below turns one of those APIs into the same
// StartupRole shape. Nothing here needs a key or a login.
import { load } from 'cheerio/slim';

export type Ats = 'ashby' | 'greenhouse' | 'lever' | 'workable' | 'gem' | 'teamtailor';
export const ATS_LIST: Ats[] = ['ashby', 'greenhouse', 'lever', 'workable', 'gem', 'teamtailor'];

export interface StartupRole {
  id: string;
  title: string;
  team: string | null;
  location: string;
  remote: boolean;
  employmentType: string | null;
  postedAt: string | null;
  url: string;
  payMin: number | null;
  payMax: number | null;
  currency: string | null;
  payInterval: string | null;
  summary: string;
}

export interface Board { ats: Ats; board: string }
export interface BoardRead { roles: StartupRole[]; boardName: string | null; text: string }
export type Get = (url: string) => Promise<string>;

const SUMMARY_CHARS = 600;
type Row = Record<string, any>;

export function plain(html: string | null | undefined): string {
  if (!html) return '';
  const text = /<[a-z!/]/i.test(html) ? load(`<div>${html}</div>`)('div').first().text() : html;
  return text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function clip(text: string): string {
  return text.length <= SUMMARY_CHARS ? text : text.slice(0, SUMMARY_CHARS).replace(/\s+\S*$/, '') + '…';
}
function iso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.replace(/[^0-9.]/g, '')) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function https(url: unknown): string | null {
  try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}
const REMOTE_WORDS = /\bremote\b|\banywhere\b|work from home/i;
function interval(value: unknown): string | null {
  const v = String(value ?? '').toLowerCase();
  if (/hour/.test(v)) return 'hour';
  if (/year|annual|salary/.test(v)) return 'year';
  if (/month/.test(v)) return 'month';
  if (/week/.test(v)) return 'week';
  if (/day/.test(v)) return 'day';
  return v ? null : null;
}
const enc = encodeURIComponent;

export function readAshby(data: Row, board: string): BoardRead {
  const jobs: Row[] = Array.isArray(data?.jobs) ? data.jobs : [];
  const roles: StartupRole[] = [];
  const text: string[] = [];
  for (const j of jobs) {
    if (j.isListed === false) continue;
    const url = https(j.jobUrl) ?? https(j.applyUrl) ?? `https://jobs.ashbyhq.com/${enc(board)}/${enc(j.id)}`;
    const locations = [j.location, ...(j.secondaryLocations ?? []).map((l: Row) => l?.location)].filter(Boolean);
    const salary = (j.compensation?.summaryComponents ?? []).find((c: Row) => /salary|hourly/i.test(c?.compensationType ?? '')) ?? null;
    const summary = plain(j.descriptionPlain ?? j.descriptionHtml);
    text.push(summary);
    roles.push({
      id: `ashby:${board}:${j.id}`,
      title: String(j.title ?? '').trim(),
      team: j.team || j.department || null,
      location: [...new Set(locations)].join(' · ') || (j.isRemote ? 'Remote' : 'Not listed'),
      remote: j.isRemote === true || /remote/i.test(j.workplaceType ?? '') || REMOTE_WORDS.test(locations.join(' ')),
      employmentType: j.employmentType ? String(j.employmentType).replace(/([a-z])([A-Z])/g, '$1 $2') : null,
      postedAt: iso(j.publishedAt),
      url,
      payMin: salary ? num(salary.minValue) : null,
      payMax: salary ? num(salary.maxValue) : null,
      currency: salary?.currencyCode ?? null,
      payInterval: salary ? interval(salary.interval ?? salary.compensationType) : null,
      summary: clip(summary),
    });
  }
  return { roles: roles.filter(r => r.title), boardName: null, text: text.join('\n') };
}

export function readGreenhouse(data: Row, board: string, boardName: string | null): BoardRead {
  const jobs: Row[] = Array.isArray(data?.jobs) ? data.jobs : [];
  const text: string[] = [];
  const roles = jobs.map((j): StartupRole => {
    const summary = plain(j.content ? load(`<div>${j.content}</div>`)('div').first().text() : '');
    text.push(summary);
    const location = String(j.location?.name ?? '').trim();
    return {
      id: `greenhouse:${board}:${j.id}`,
      title: String(j.title ?? '').trim(),
      team: j.departments?.[0]?.name ?? null,
      location: location || 'Not listed',
      remote: REMOTE_WORDS.test(location),
      employmentType: null,
      postedAt: iso(j.first_published ?? j.updated_at),
      url: https(j.absolute_url) ?? `https://job-boards.greenhouse.io/${enc(board)}/jobs/${enc(j.id)}`,
      payMin: null, payMax: null, currency: null, payInterval: null,
      summary: clip(summary),
    };
  });
  return { roles: roles.filter(r => r.title), boardName, text: text.join('\n') };
}

export function readLever(data: unknown, board: string): BoardRead {
  const jobs: Row[] = Array.isArray(data) ? data : [];
  const text: string[] = [];
  const roles = jobs.map((j): StartupRole => {
    const summary = plain(j.descriptionPlain ?? j.description);
    text.push(summary);
    const c = j.categories ?? {};
    const locations: string[] = (Array.isArray(c.allLocations) && c.allLocations.length ? c.allLocations : [c.location]).filter(Boolean);
    const s = j.salaryRange;
    return {
      id: `lever:${board}:${j.id}`,
      title: String(j.text ?? '').trim(),
      team: c.team || c.department || null,
      location: locations.join(' · ') || 'Not listed',
      remote: /remote/i.test(j.workplaceType ?? '') || REMOTE_WORDS.test(locations.join(' ')),
      employmentType: c.commitment || null,
      postedAt: iso(j.createdAt),
      url: https(j.hostedUrl) ?? `https://jobs.lever.co/${enc(board)}/${enc(j.id)}`,
      payMin: s ? num(s.min) : null,
      payMax: s ? num(s.max) : null,
      currency: s?.currency ?? null,
      payInterval: s ? interval(s.interval) : null,
      summary: clip(summary),
    };
  });
  return { roles: roles.filter(r => r.title), boardName: null, text: text.join('\n') };
}

export function readWorkable(data: Row, board: string): BoardRead {
  const jobs: Row[] = Array.isArray(data?.jobs) ? data.jobs : [];
  const roles = jobs.map((j): StartupRole => {
    const place = [j.city, j.state, j.country].filter(Boolean).join(', ');
    const locations = Array.isArray(j.locations) && j.locations.length
      ? j.locations.map((l: Row) => [l.city, l.region, l.country].filter(Boolean).join(', ')).filter(Boolean)
      : [place].filter(Boolean);
    return {
      id: `workable:${board}:${j.shortcode ?? j.id}`,
      title: String(j.title ?? '').trim(),
      team: j.department || null,
      location: locations.join(' · ') || (j.telecommuting ? 'Remote' : 'Not listed'),
      remote: j.telecommuting === true || REMOTE_WORDS.test(locations.join(' ')),
      employmentType: j.employment_type || null,
      postedAt: iso(j.published_on ?? j.created_at),
      url: https(j.url) ?? https(j.shortlink) ?? `https://apply.workable.com/${enc(board)}/j/${enc(j.shortcode)}/`,
      payMin: null, payMax: null, currency: null, payInterval: null,
      summary: '',
    };
  });
  return { roles: roles.filter(r => r.title), boardName: data?.name ?? null, text: '' };
}

export function readGem(data: unknown, board: string): BoardRead {
  const jobs: Row[] = Array.isArray(data) ? data : [];
  const text: string[] = [];
  const roles = jobs.map((j): StartupRole => {
    const summary = plain(j.content_plain ?? j.content);
    text.push(summary);
    const location = String(j.location?.name ?? j.offices?.[0]?.name ?? '').trim();
    return {
      id: `gem:${board}:${j.id}`,
      title: String(j.title ?? '').trim(),
      team: j.departments?.[0]?.name ?? null,
      location: location || 'Not listed',
      remote: /remote/i.test(j.location_type ?? '') || REMOTE_WORDS.test(location),
      employmentType: j.employment_type ? String(j.employment_type).replace(/_/g, ' ') : null,
      postedAt: iso(j.first_published_at ?? j.created_at ?? j.updated_at),
      url: https(j.absolute_url) ?? `https://jobs.gem.com/${enc(board)}/${enc(j.id)}`,
      payMin: null, payMax: null, currency: null, payInterval: null,
      summary: clip(summary),
    };
  });
  return { roles: roles.filter(r => r.title), boardName: null, text: text.join('\n') };
}

// Teamtailor publishes an RSS feed of open jobs on every career site.
export function readTeamtailor(xml: string, board: string): BoardRead {
  const $ = load(xml, { xml: true });
  const text: string[] = [];
  const roles: StartupRole[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const link = https(item.find('link').first().text().trim());
    if (!link) return;
    const summary = plain(item.find('description').first().text());
    text.push(summary);
    const locations = item.find('tt\\:location, location').map((_, l) => $(l).find('tt\\:city, city').text().trim() || $(l).text().trim()).get().filter(Boolean);
    const remoteStatus = item.find('remoteStatus, tt\\:remoteStatus').first().text();
    roles.push({
      id: `teamtailor:${board}:${link.split('/jobs/')[1]?.split(/[/?]/)[0] ?? link}`,
      title: item.find('title').first().text().trim(),
      team: item.find('department, tt\\:department').first().text().trim() || null,
      location: [...new Set(locations)].join(' · ') || 'Not listed',
      remote: /remote|fully|hybrid/i.test(remoteStatus) ? /fully|remote/i.test(remoteStatus) : REMOTE_WORDS.test(locations.join(' ')),
      employmentType: null,
      postedAt: iso(item.find('pubDate').first().text()),
      url: link,
      payMin: null, payMax: null, currency: null, payInterval: null,
      summary: clip(summary),
    });
  });
  return { roles: roles.filter(r => r.title), boardName: null, text: text.join('\n') };
}

// Where each board's public listing lives.
export function boardUrl({ ats, board }: Board): string {
  const b = enc(board);
  switch (ats) {
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`;
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${b}?mode=json`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${b}`;
    case 'gem': return `https://api.gem.com/job_board/v0/${b}/job_posts/`;
    case 'teamtailor': return `https://${b}.teamtailor.com/jobs.rss`;
  }
}

// Reads one board. Throws when the board does not exist or answers with
// something that is not a job listing, which discovery treats as a miss.
export async function readBoard(target: Board, get: Get): Promise<BoardRead> {
  const body = await get(boardUrl(target));
  if (target.ats === 'teamtailor') {
    if (!/<rss|<channel/i.test(body)) throw new Error('Not a Teamtailor feed.');
    return readTeamtailor(body, target.board);
  }
  let data: any;
  try { data = JSON.parse(body); } catch { throw new Error('Board did not answer with JSON.'); }
  switch (target.ats) {
    case 'ashby':
      if (!Array.isArray(data?.jobs)) throw new Error('Not an Ashby board.');
      return readAshby(data, target.board);
    case 'greenhouse': {
      if (!Array.isArray(data?.jobs)) throw new Error('Not a Greenhouse board.');
      let name: string | null = null;
      try { name = JSON.parse(await get(`https://boards-api.greenhouse.io/v1/boards/${enc(target.board)}`))?.name ?? null; } catch { /* the name only helps matching */ }
      return readGreenhouse(data, target.board, name);
    }
    case 'lever':
      if (!Array.isArray(data)) throw new Error('Not a Lever board.');
      return readLever(data, target.board);
    case 'workable':
      if (!Array.isArray(data?.jobs)) throw new Error('Not a Workable board.');
      return readWorkable(data, target.board);
    case 'gem':
      if (!Array.isArray(data)) throw new Error('Not a Gem board.');
      return readGem(data, target.board);
  }
}

const SKIP_SLUGS = new Set(['api', 'embed', 'v1', 'j', 'jobs', 'job', 'careers', 'apply', 'www', 'static', 'assets', 'widget', 'job_board', 'boards']);

// Finds job board links on a company's own careers page.
export function boardsInHtml(html: string): Board[] {
  const found: Board[] = [];
  const add = (ats: Ats, board: string | undefined) => {
    if (!board) return;
    const clean = decodeURIComponent(board).trim();
    if (!clean || SKIP_SLUGS.has(clean.toLowerCase())) return;
    if (!found.some(f => f.ats === ats && f.board.toLowerCase() === clean.toLowerCase())) found.push({ ats, board: clean });
  };
  const patterns: [Ats, RegExp][] = [
    ['ashby', /jobs\.ashbyhq\.com\/([^/"'?#\s<>\\]+)/gi],
    ['ashby', /ashbyhq\.com\/api\/non-user-graphql[^"']*organizationHostedJobsPageName["':\s]+([A-Za-z0-9_.-]+)/gi],
    ['greenhouse', /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/gi],
    ['greenhouse', /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/gi],
    ['lever', /jobs\.lever\.co\/([A-Za-z0-9_.-]+)/gi],
    ['lever', /api\.lever\.co\/v0\/postings\/([A-Za-z0-9_.-]+)/gi],
    ['workable', /apply\.workable\.com\/([A-Za-z0-9_-]+)/gi],
    ['gem', /jobs\.gem\.com\/([A-Za-z0-9_-]+)/gi],
    ['teamtailor', /https?:\/\/([a-z0-9-]+)\.teamtailor\.com/gi],
  ];
  for (const [ats, re] of patterns) for (const m of html.matchAll(re)) add(ats, m[1]);
  return found;
}
