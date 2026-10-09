import { load } from 'cheerio/slim';
import type { Job } from '../src/types.js';
import type { SourceConfig } from './sources.js';

export function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return load(`<div>${value}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}
export function descriptionText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const $=load(`<div id="description-root">${value}</div>`);
  $('script,style,iframe,form,button,nav').remove();
  $('br').replaceWith('\n');
  $('li').each((_,el)=>{$(el).prepend('\n• ');$(el).append('\n');});
  $('p,div,section,article,h1,h2,h3,h4,h5,h6,ul,ol,table,tr,blockquote').each((_,el)=>{$(el).prepend('\n');$(el).append('\n');});
  return $('#description-root').text().replace(/[^\S\n]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function classify(title: string, sourceCategory = ''): string {
  const t = `${title} ${sourceCategory}`.toLowerCase();
  if (/data|analytics|business intelligence|machine learning|statistic/.test(t)) return 'Data & Analytics';
  if (/software|developer|engineer|cyber|cloud|devops|technical|systems/.test(t)) return 'Engineering & IT';
  if (/design|ux|ui |creative|artist/.test(t)) return 'Design & Creative';
  if (/product|program|project/.test(t)) return 'Product & Operations';
  if (/market|content|communication|brand|sales/.test(t)) return 'Marketing & Sales';
  if (/finance|account|financial|audit|bank/.test(t)) return 'Finance & Accounting';
  if (/clinical|lab|scient|medical|health|pharma|research/.test(t)) return 'Science & Healthcare';
  return 'Business & Operations';
}
export function safeUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const u = new URL(value, base); return u.protocol === 'https:' ? u.toString().split('#')[0] : null; } catch { return null; }
}
export function date(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}
export function money(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function workMode(value: unknown): Job['workMode'] {
  const text = String(value || '').toLowerCase();
  if (/hybrid/.test(text)) return 'Hybrid';
  if (/remote|telecommute/.test(text)) return 'Remote';
  if (/on.?site|office/.test(text)) return 'On-site';
  return 'Unspecified';
}
export function deriveSkills(description: string): string[] {
  const candidates = ['Python','SQL','Tableau','Power BI','Excel','JavaScript','TypeScript','React','AWS','Azure','Java','C++','Salesforce','SAP','Figma','R','Snowflake','Databricks','Kubernetes','GCP'];
  return candidates.filter(x => new RegExp(`(^|[^a-z])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`,'i').test(description)).slice(0,8);
}
export function makeJob(source: SourceConfig, input: Partial<Job> & { sourceJobId: string; title: string; applyUrl: string }, now: string): Job | null {
  const applyUrl = safeUrl(input.applyUrl, source.url);
  const title = plainText(input.title).slice(0,240);
  if (!title || !applyUrl || !input.sourceJobId) return null;
  const description = descriptionText(input.description).slice(0,18000);
  return {
    id: `${source.id}:${input.sourceJobId}`,
    sourceId: source.id,
    sourceJobId: input.sourceJobId,
    company: source.company,
    title,
    location: input.location?.trim() || 'Location not specified',
    country: input.country || source.country,
    workMode: input.workMode || 'Unspecified',
    employmentType: plainText(input.employmentType) || 'Contract',
    category: classify(title, input.category),
    description,
    skills: input.skills?.length ? input.skills.slice(0,10) : deriveSkills(description),
    duration: input.duration || null,
    payMin: money(input.payMin),
    payMax: money(input.payMax),
    payPeriod: input.payPeriod || null,
    currency: input.currency || null,
    postedAt: date(input.postedAt),
    firstSeenAt: now,
    lastSeenAt: now,
    applyUrl,
    provider: source.provider,
    active: true,
  };
}
