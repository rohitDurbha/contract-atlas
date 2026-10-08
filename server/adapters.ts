import { load } from 'cheerio/slim';
import type { Job, Source } from '../src/types.js';
import type { SourceConfig } from './sources.js';
import { date, makeJob, money, plainText, safeUrl, workMode } from './normalize.js';

type RecordData = Record<string, any>;
export interface Collection {
  jobs: Job[];
  status: Source['status'];
  message: string;
  complete: boolean;
  advertisedCount?: number;
}
export class FetchError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function fetchPublic(url: string, headers: Record<string,string> = {}): Promise<string> {
  for (let attempt=0; attempt<2; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ContractAtlas/1.0 (public contract job aggregator)', 'Accept': 'application/json,text/html;q=0.9', ...headers }, signal: AbortSignal.timeout(9000), redirect: 'follow' });
    if (response.ok) {
      const body = await response.text();
      if (body.length > 8_000_000) throw new Error('Response exceeded the collection size limit.');
      return body;
    }
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      const retry = Number(response.headers.get('retry-after')) || 1;
      if (retry > 2) throw new FetchError(response.status, 'Source requested a longer cooldown; retry on the next run.');
      await new Promise(r => setTimeout(r, retry * 1000));
      continue;
    }
    throw new FetchError(response.status, `Public source returned HTTP ${response.status}.`);
  }
  throw new Error('Source request failed.');
}

export function robotsAllowed(text: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group: (typeof groups)[number] | undefined;
  for (const raw of text.split('\n')) {
    const line=raw.split('#')[0].trim(); const colon=line.indexOf(':');
    if (colon<0) continue;
    const key=line.slice(0,colon).trim().toLowerCase(), value=line.slice(colon+1).trim();
    if (key==='user-agent') {
      if (!group || group.rules.length) { group={agents:[],rules:[]}; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow','disallow'].includes(key) && value) group.rules.push({allow:key==='allow',path:value});
  }
  const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&'contractatlas'.startsWith(a)));
  const chosen=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
  const matching=chosen.flatMap(g=>g.rules).filter(r=> {
    const pattern=r.path.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\\\$$/,'$');
    return new RegExp(`^${pattern}`).test(path);
  }).sort((a,b)=>b.path.length-a.path.length || Number(b.allow)-Number(a.allow));
  return matching[0]?.allow ?? true;
}
async function checkRobots(source: SourceConfig) {
  const u=new URL(source.url);
  try {
    const robots=await fetchPublic(`${u.origin}/robots.txt`);
    if (!robots.includes('<html') && !robotsAllowed(robots,u.pathname)) throw new FetchError(403,'The source disallows automated collection on this path.');
  } catch (error) { if (error instanceof FetchError && (error.status === 403 || error.status === 401 || error.status === 429)) throw error; }
}

export function parseHireHQ(source: SourceConfig, rows: RecordData[], now: string, metadata: RecordData): Job[] {
  const label=(key:string,code:unknown) => (metadata[key] || []).find((x:RecordData)=>String(x.code)===String(code))?.status || '';
  return rows.filter(r=>/contract|contingent|temp/i.test(label('job_job_type',r.job_type)) && (r.status===undefined || Number(r.status)===1)).map(r=> {
    const visible = r.pay_rate_visibility === true || String(r.pay_rate_visibility).toLowerCase() === 'true';
    const cur=label('job_currency',r.currency) || label('currency_currency',r.currency);
    const currency=/^[A-Z]{3}$/.test(cur)?cur:null;
    const period=label('job_payment_term',r.payment_term).replace(/^per\s*/i,'').toLowerCase();
    const domain=source.domain || source.id;
    const encoded=btoa(JSON.stringify({validDomainNames:domain,source:'C'}));
    return makeJob(source,{
      sourceJobId:String(r.job_id || ''),title:r.job_title,
      applyUrl:`https://candidate-v2.hirehq.ai/public/job-details?jobId=${encodeURIComponent(r.job_id)}&domain=${encodeURIComponent(encoded)}`,
      description:r.job_description_text,location:[r.city,r.state,r.country].filter(Boolean).join(', '),country:r.country,
      category:r.job_category,workMode:workMode(label('job_work_from',r.work_from)),postedAt:r.posted_on,
      payMin:visible?money(r.budget_minimum_per_payment_term):null,payMax:visible?money(r.budget_maximum_per_payment_term):null,
      payPeriod:visible?period:null,currency:visible?currency:null,
      duration:r.duration?`${r.duration} ${label('job_duration_type',r.duration_type) || 'units (see source)'}`:null,
    },now);
  }).filter((x):x is Job=>!!x);
}

let hireMetadata: RecordData | null = null;
async function hireHQ(source: SourceConfig, html: string, now: string): Promise<Collection> {
  const found=html.match(/https:\/\/services\.hirehq\.ai\/ats\/api\/v1\/public\/jobs\/domain\?validDomainName=([^&"'\s]+)/);
  const domain=found?.[1] || source.domain;
  if (!domain) return generic(source,html,now);
  const enriched={...source,domain};
  if (!hireMetadata) hireMetadata=JSON.parse(await fetchPublic('https://services.hirehq.ai/ats/api/v1/status/metadata')).metadata;
  let jobs:Job[]=[],complete=false;
  for (let page=1;page<=30;page++) {
    const data=JSON.parse(await fetchPublic(`https://services.hirehq.ai/ats/api/v1/public/jobs/domain?validDomainName=${encodeURIComponent(domain)}&limit=100&page=${page}`));
    const rows=data.jobs;
    if (!Array.isArray(rows)) throw new Error('The source returned an unexpected job response.');
    jobs.push(...parseHireHQ(enriched,rows,now,hireMetadata!));
    if (rows.length<100 || page*100 >= Number(data.count)) { complete=true; break; }
  }
  return {jobs:unique(jobs),complete,status:'healthy',message:`Public API collected ${jobs.length} contract roles${complete?'':'; pagination limit reached'}.`};
}

function eligibleTalentNet(r:RecordData):boolean {
  return !r.closed && !r.closedAt && !/closed|expired|draft|on hold|cancelled|withdrawn|archived/i.test(String(r.status || '')) && (!r.type || /contract|temp|contingent/i.test(String(r.type)));
}
export function parseTalentNet(source: SourceConfig, rows: RecordData[], now: string): Job[] {
  return rows.filter(eligibleTalentNet).map(r=> {
    const location=r.location || r.locations?.[0] || {};
    const title=typeof r.title==='object'?r.title?.name:r.title || r.name || r.jobTitle;
    const rate=r.rate || r.payRate || {};
    const id=r.id || r.uuid || r.sourceJobId || '';
    return makeJob(source,{
      sourceJobId:String(id),title,
      applyUrl:`${new URL(source.url).origin}/jobs/${encodeURIComponent(id)}`,
      description:r.description || r.jobDescription,
      location:typeof location==='string'?location:[location.city,location.state || location.code,typeof location.country==='string'?location.country:location.country?.name].filter(Boolean).join(', ') || location.address,
      country:location.countryCode || location.country?.name || location.country?.code || (typeof location.country==='string'?location.country:source.country),
      workMode:workMode(r.workplaceType || r.workType || r.remoteType || (r.isRemote?'remote':null)),category:r.category?.name || r.category,
      postedAt:r.publishedOrCreatedTime || r.publishedAt || r.publishedDate || r.postedAt || r.createdAt,
      duration:r.durationText || (typeof r.duration==='string'?r.duration:null),
      payMin:money(r.payRangeMin ?? r.rateMin ?? r.minRate ?? rate.min),payMax:money(r.payRangeMax ?? r.rateMax ?? r.maxRate ?? rate.max),
      currency:r.payRangeCurrency || (typeof r.currency==='string'?r.currency:rate.currency),
      payPeriod:r.payRangeUnit || r.rateUnit || rate.unit || null,
      skills:Array.isArray(r.skills)?r.skills.map((s:RecordData|string)=>typeof s==='string'?s:s.name).filter(Boolean):[],
    },now);
  }).filter((x):x is Job=>!!x);
}
async function talentNet(source: SourceConfig, html: string, now: string): Promise<Collection> {
  const tenant=html.match(/window\.tenant\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const env=html.match(/window\.env\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!tenant || !env) return generic(source,html,now);
  const config=JSON.parse(await fetchPublic(`${new URL(source.url).origin}/${encodeURIComponent(env)}/${encodeURIComponent(tenant)}.json`));
  const api=new URL(config.endpoints.api);
  if (!api.hostname.endsWith('.talentnet.community')) throw new Error('The source API host is outside the allowed provider.');
  let jobs:Job[]=[],complete=false,received=0,advertisedCount:number|undefined,malformed=false;
  const seenPages=new Set<string>();
  const seenIds=new Set<string>();
  for (let page=1;page<=50;page++) {
    const data=JSON.parse(await fetchPublic(`${api.origin}/api/community/jobs/search?limit=100&page=${page}`,{'x-tenant':config.tenant || tenant,'Accept-Language':'en','x-spa-type':'community','X-Requested-With':'XMLHttpRequest'}));
    const rows=data.data || data.jobs;
    if (!Array.isArray(rows)) throw new Error('The source returned an unexpected job response.');
    const fingerprint=JSON.stringify(rows.map((r:RecordData)=>r.id || r.uuid));
    if(rows.length && seenPages.has(fingerprint)) throw new Error('The source repeated a page; full coverage could not be verified.');
    seenPages.add(fingerprint);
    received+=rows.length;
    rows.forEach((r:RecordData)=>{if(r.id || r.uuid || r.sourceJobId) seenIds.add(String(r.id || r.uuid || r.sourceJobId));else malformed=true;});
    const total=Number(data.meta?.totalCount ?? data.meta?.total ?? data.meta?.totalItems);
    if(Number.isFinite(total) && total>=0) advertisedCount=total;
    const parsed=parseTalentNet(source,rows,now);
    if(parsed.length<rows.filter(eligibleTalentNet).length) malformed=true;
    jobs.push(...parsed);
    const pageCount=Number(data.meta?.pageCount);
    // Providers may cap page size below the requested limit. Metadata, not row length, decides completion.
    if((advertisedCount!==undefined && received>=advertisedCount) || (pageCount>0 && page>=pageCount) || (!rows.length)) {
      complete=advertisedCount===undefined || received>=advertisedCount;break;
    }
    if(advertisedCount===undefined && !(pageCount>0) && rows.length<100) {complete=true;break;}
  }
  complete=complete && !malformed && (advertisedCount===undefined || seenIds.size>=advertisedCount);
  jobs=unique(jobs);
  return {jobs,complete,advertisedCount,status:'healthy',message:`Public listing API collected ${jobs.length} contract roles across all ${complete?'available':'retrieved'} pages${advertisedCount!==undefined?`; ${advertisedCount} records advertised`:''}${complete?'':'; full coverage has not been verified'}.`};
}

export function parseJSONLD(source: SourceConfig, html: string, now: string): Job[] {
  const $=load(html), rows:RecordData[]=[];
  const walk=(data:any):void=> {
    if (Array.isArray(data)) {data.forEach(walk);return;}
    if (!data || typeof data!=='object') return;
    const types=Array.isArray(data['@type'])?data['@type']:[data['@type']];
    if (types.includes('JobPosting')) rows.push(data);
    for (const key of ['@graph','itemListElement','item','mainEntity']) if(data[key]) walk(data[key]);
  };
  $('script[type="application/ld+json"]').each((_,s)=> {try {walk(JSON.parse($(s).text()));} catch { /* ignore unrelated invalid metadata */ } });
  return rows.filter(r=> {
    const type=String(r.employmentType || '');
    if (type && !/contract|temp|contingent/i.test(type)) return false;
    return source.contractOnly || /contract|temp|contingent/i.test(type);
  }).filter(r=>!r.validThrough || !date(r.validThrough) || date(r.validThrough)!>now).map(r=> {
    const addr=r.jobLocation?.address || r.jobLocation?.[0]?.address || {};
    const sal=r.baseSalary || {},val=sal.value || {};
    const apply=safeUrl(r.url || r.identifier?.url,source.url);
    if (!apply) return null;
    return makeJob(source,{
      sourceJobId:String(r.identifier?.value || apply),title:r.title,applyUrl:apply,description:r.description,
      location:[addr.addressLocality,addr.addressRegion,addr.addressCountry].filter(Boolean).join(', '),
      country:typeof addr.addressCountry==='string'?addr.addressCountry:source.country,workMode:workMode(r.jobLocationType),
      postedAt:r.datePosted,payMin:money(val.minValue || val.value),payMax:money(val.maxValue),payPeriod:val.unitText?.toLowerCase(),currency:sal.currency,
    },now);
  }).filter((x):x is Job=>!!x);
}
function unique(jobs:Job[]):Job[] {return [...new Map(jobs.map(j=>[j.id,j])).values()];}
async function generic(source: SourceConfig, html: string, now: string): Promise<Collection> {
  let jobs=parseJSONLD(source,html,now);
  if (jobs.length) return {jobs,complete:false,status:'healthy',message:`Collected ${jobs.length} structured job records; completeness is not guaranteed.`};
  const $=load(html); const urls=new Set<string>();
  $('a[href]').each((_,a)=> {
    const href=safeUrl($(a).attr('href'),source.url);
    if (!href) return;
    const u=new URL(href),base=new URL(source.url);
    if (u.hostname===base.hostname && /\/(?:jobs?|job-details|opportunities)\/(?!search|categories|apply)[^/?]{5,}/i.test(u.pathname)) urls.add(href);
  });
  // Public detail pages may expose JobPosting even when the listing page is a JS shell.
  const detailUrls=[...urls].slice(0,60);
  for (let offset=0;offset<detailUrls.length;offset+=4) {
    const results=await Promise.allSettled(detailUrls.slice(offset,offset+4).map(async url=>parseJSONLD(source,await fetchPublic(url),now)));
    for (const result of results) if(result.status==='fulfilled') jobs.push(...result.value);
  }
  jobs=unique(jobs);
  if (jobs.length) return {jobs,complete:false,status:'healthy',message:`Collected ${jobs.length} contract roles from public detail pages; additional pages may exist.`};
  // Static empty-state templates are common in JS portals. They cannot prove a board is empty.
  return {jobs:[],complete:false,status:'needs_adapter',message:'No structured listings were readable. The portal needs a provider adapter or browser rendering. Open the original source to browse.'};
}

export async function collectSource(source: SourceConfig, now = new Date().toISOString()): Promise<Collection> {
  try {
    if(source.provider==='TalentNet') {
      // Discover the published JSON feed from the permitted landing page, rather than crawling the JS search route.
      // This is the site's unauthenticated listing API. Never send a candidate token or request private endpoints.
      const landing={...source,url:`${new URL(source.url).origin}/`};
      await checkRobots(landing);
      return await talentNet(source,await fetchPublic(landing.url),now);
    }
    await checkRobots(source);
    const html=await fetchPublic(source.url);
    if (source.provider==='KellyOCG') return await hireHQ(source,html,now);
    return await generic(source,html,now);
  } catch (error) {
    const blocked=error instanceof FetchError && [401,403,429].includes(error.status);
    return {jobs:[],complete:false,status:blocked?'blocked':'error',message:error instanceof Error?error.message.slice(0,200):'Collection failed; existing roles retained.'};
  }
}
