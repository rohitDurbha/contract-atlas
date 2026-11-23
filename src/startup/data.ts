// Shapes and pure helpers for the StartupAtlas tab. Kept apart from the
// component so they can be tested without a browser.
export interface StartupCompany {
  id: string; name: string; focus: string; location: string; careersUrl?: string;
  fastestRank?: number; tier?: string; breakoutFocus?: string;
  ats: string | null; board: string | null; boardUrl: string | null;
  status: string; message: string | null; roleCount: number; remoteCount: number; checkedAt: string | null;
}
export interface StartupJob {
  id: string; companyId: string; title: string; team: string | null; location: string; remote: boolean;
  employmentType: string | null; postedAt: string | null; firstSeenAt: string; url: string;
  payMin: number | null; payMax: number | null; currency: string | null; payInterval: string | null;
}
export interface StartupOverview { companies: number; withBoards: number; roles: number; remoteRoles: number; newThisWeek: number; updatedAt: string | null }

export type Segment = 'all' | 'fastest' | 'early' | 'growth' | 'scale' | 'large';
export const SEGMENTS: { id: Segment; label: string; tiers?: string[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'fastest', label: 'Fastest 32' },
  { id: 'early', label: '1–25', tiers: ['1-10', '11-25'] },
  { id: 'growth', label: '26–100', tiers: ['26-50', '51-100'] },
  { id: 'scale', label: '101–250', tiers: ['101-250'] },
  { id: 'large', label: '250+', tiers: ['250+'] },
];
export function inSegment(c: StartupCompany, segment: Segment): boolean {
  if (segment === 'all') return true;
  if (segment === 'fastest') return c.fastestRank != null;
  return !!c.tier && !!SEGMENTS.find(s => s.id === segment)?.tiers?.includes(c.tier);
}

// Role families read from the title first and the team second, since team
// names differ on every board.
export const FAMILIES = ['Engineering', 'Research', 'Design', 'Product', 'Data', 'Sales', 'Marketing', 'Operations', 'People', 'Finance & Legal', 'Support', 'Other'] as const;
export type Family = (typeof FAMILIES)[number];
const RULES: [Family, RegExp][] = [
  ['Research', /research|scientist|phd|post-?training|pre-?training|alignment|evals?\b/i],
  ['Data', /\bdata\b|analytics|analyst|machine learning engineer.*data/i],
  ['Design', /design|ux\b|ui\b|brand|creative|illustrat/i],
  ['Product', /product manager|product lead|\bpm\b|product owner|program manager|technical program/i],
  ['Engineering', /engineer|developer|swe\b|sre\b|devops|infrastructure|platform|architect|firmware|hardware|technician|machinist|scientist|security|forward deployed|ml\b|ai\b/i],
  ['Sales', /sales|account exec|\bae\b|\bsdr\b|\bbdr\b|business development|partnership|solutions consultant|go-to-market|gtm|deal/i],
  ['Marketing', /marketing|growth|content|community|communications|\bpr\b|social|events|demand gen|brand/i],
  ['Support', /support|success|customer experience|implementation|onboarding|solutions/i],
  ['People', /recruit|talent|people|\bhr\b|human resources|culture/i],
  ['Finance & Legal', /finance|account(ant|ing)|controller|tax|legal|counsel|paralegal|compliance|attorney|lawyer|treasury|fp&a/i],
  ['Operations', /operations|ops\b|supply|logistics|procurement|manufactur|production|facilities|\boffice\b|executive assistant|chief of staff|program|project/i],
];
export function family(job: Pick<StartupJob, 'title' | 'team'>): Family {
  for (const [name, re] of RULES) if (re.test(job.title)) return name;
  for (const [name, re] of RULES) if (job.team && re.test(job.team)) return name;
  return 'Other';
}

export interface Filters { segment: Segment; company: string | null; remote: boolean; family: Family | null; withPay: boolean; query: string }
export const EMPTY_FILTERS: Filters = { segment: 'all', company: null, remote: false, family: null, withPay: false, query: '' };

export function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
export function matchesQuery(job: StartupJob, company: StartupCompany | undefined, words: string[]): boolean {
  if (!words.length) return true;
  const hay = `${job.title} ${job.team ?? ''} ${job.location} ${company?.name ?? ''} ${company?.focus ?? ''}`.toLowerCase();
  return words.every(w => hay.includes(w));
}
export function filterJobs(jobs: StartupJob[], companies: Map<string, StartupCompany>, f: Filters): StartupJob[] {
  const words = tokens(f.query);
  return jobs.filter(j => {
    const c = companies.get(j.companyId);
    if (!c || !inSegment(c, f.segment)) return false;
    if (f.company && j.companyId !== f.company) return false;
    if (f.remote && !j.remote) return false;
    if (f.withPay && j.payMin == null && j.payMax == null) return false;
    if (f.family && family(j) !== f.family) return false;
    return matchesQuery(j, c, words);
  });
}

export function relative(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  const days = Math.round(minutes / 1440);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

function short(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k`.replace('.0k', 'k') : String(Math.round(n));
}
export function payLabel(j: Pick<StartupJob, 'payMin' | 'payMax' | 'currency' | 'payInterval'>): string {
  if (j.payMin == null && j.payMax == null) return '—';
  const symbol = j.currency === 'USD' ? '$' : j.currency === 'EUR' ? '€' : j.currency === 'GBP' ? '£' : j.currency ? `${j.currency} ` : '';
  const range = j.payMin != null && j.payMax != null && j.payMin !== j.payMax ? `${short(j.payMin)}–${short(j.payMax)}` : short((j.payMin ?? j.payMax)!);
  const per = j.payInterval === 'hour' ? '/hr' : j.payInterval === 'month' ? '/mo' : j.payInterval === 'year' ? '/yr' : '';
  return `${symbol}${range}${per}`;
}

// A tiny fuzzy score for the command palette. Every typed character must
// appear in order, and runs of consecutive matches and word starts score higher.
export function fuzzy(text: string, query: string): number {
  const t = text.toLowerCase(), q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || /\W/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return score - t.length * 0.01;
}
