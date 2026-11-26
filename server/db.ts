import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { and, eq, like, or, sql, desc, inArray, type SQL } from 'drizzle-orm';
import * as schema from './schema.js';
import { SOURCES, RETIRED_SOURCE_IDS } from './sources.js';
import seed from './seed.json' with { type: 'json' };
import type { Job, Feed, Source } from '../src/types.js';
import { feedCutoff, PERMANENT_TYPES } from './policy.js';
import type { Database, Statement } from './database.js';

const DDL = [
  'CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY,company TEXT NOT NULL,provider TEXT NOT NULL,url TEXT NOT NULL,country TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'pending\',last_checked_at TEXT,last_success_at TEXT,message TEXT)',
  'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,company TEXT NOT NULL,title TEXT NOT NULL,location TEXT NOT NULL,country TEXT NOT NULL,work_mode TEXT NOT NULL,category TEXT NOT NULL,pay_min REAL,pay_max REAL,posted_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,apply_url TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,duplicate INTEGER NOT NULL DEFAULT 0,UNIQUE(source_id,apply_url))',
  // Feed queries filter on active and the stored repost flag, then sort by
  // freshness, so one index serves the filter and the default order. It
  // replaces jobs_freshness, which did not include the flag.
  'DROP INDEX IF EXISTS jobs_freshness',
  'CREATE INDEX IF NOT EXISTS jobs_filters ON jobs(company,category,work_mode)',
  'CREATE INDEX IF NOT EXISTS jobs_sources ON jobs(source_id,active,last_seen_at)',
  'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,status TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,source_count INTEGER NOT NULL DEFAULT 0,success_count INTEGER NOT NULL DEFAULT 0,new_count INTEGER NOT NULL DEFAULT 0,job_count INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS source_coverage (source_id TEXT PRIMARY KEY,complete INTEGER NOT NULL DEFAULT 0,advertised_count INTEGER,fetched_count INTEGER NOT NULL DEFAULT 0,checked_at TEXT NOT NULL)',
  // Fields an LLM extracted from each role at collection time. A separate
  // table keeps them safe from the job upsert, and input_hash tells the
  // refresh which roles changed since they were last enriched.
  'CREATE TABLE IF NOT EXISTS job_enrichment (job_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,skills TEXT NOT NULL,seniority TEXT NOT NULL,normalized_title TEXT NOT NULL,remote TEXT NOT NULL,pay_min REAL,pay_max REAL,enriched_at TEXT NOT NULL)',
  // Embedding vectors for semantic search, stored as little-endian float32
  // blobs. input_hash covers the embedded text and the model, so the refresh
  // only embeds roles that are new or changed.
  'CREATE TABLE IF NOT EXISTS job_embeddings (job_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,vector BLOB NOT NULL,embedded_at TEXT NOT NULL)',
];
// Snapshots built before a column existed are upgraded in place, since
// CREATE TABLE IF NOT EXISTS leaves an existing table untouched.
const ADDED_COLUMNS:[table:string,column:string,definition:string][]=[
  ['jobs','duplicate','INTEGER NOT NULL DEFAULT 0'],
];
async function addMissingColumns(db: Database): Promise<void> {
  for (const [table,column,definition] of ADDED_COLUMNS) {
    const found=await db.prepare(`SELECT 1 AS present FROM pragma_table_info('${table}') WHERE name=?`).bind(column).first();
    if (!found) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}
// Indexes on columns that older snapshots gain through addMissingColumns,
// so they are created only once those columns exist.
const LATE_INDEXES=[
  'CREATE INDEX IF NOT EXISTS jobs_feed ON jobs(active,duplicate,posted_at DESC,first_seen_at DESC)',
];
const ready = new WeakMap<Database, Promise<void>>();
export async function ensureDB(db: Database): Promise<void> {
  if (!db) throw new Error('The database binding is unavailable.');
  if ((db as Database & {readOnly?:boolean}).readOnly) return;
  let pending=ready.get(db);
  if (!pending) {
    pending=(async()=> {
      await db.batch(DDL.map(s=>db.prepare(s)));
      await addMissingColumns(db);
      await db.batch(LATE_INDEXES.map(s=>db.prepare(s)));
      await db.batch(SOURCES.map(s=>db.prepare('INSERT INTO sources(id,company,provider,url,country) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET company=excluded.company,provider=excluded.provider,url=excluded.url,country=excluded.country').bind(s.id,s.company,s.provider,s.url,s.country)));
      const seeded=await db.prepare("SELECT value FROM settings WHERE key='seeded'").first();
      if (!seeded && seed.jobs.length) {
        for (let i=0;i<seed.jobs.length;i+=25) await db.batch((seed.jobs as unknown as Job[]).slice(i,i+25).map(j=>jobStatement(db,j)));
        for (const s of seed.sources as any[]) {
          await db.prepare('UPDATE sources SET status=?,last_checked_at=?,last_success_at=?,message=? WHERE id=?').bind(s.status,s.lastCheckedAt ?? seed.collectedAt,s.lastSuccessAt ?? (s.status==='healthy'?seed.collectedAt:null),s.message,s.id).run();
          await db.prepare('INSERT OR IGNORE INTO source_coverage(source_id,complete,advertised_count,fetched_count,checked_at) VALUES(?,?,?,?,?)').bind(s.id,s.complete?1:0,s.advertisedCount??null,s.fetchedCount ?? s.jobCount,s.lastCheckedAt ?? seed.collectedAt).run();
        }
        for (const r of (seed as any).runs ?? []) {
          await db.prepare('INSERT OR IGNORE INTO runs(id,status,started_at,completed_at,source_count,success_count,new_count,job_count,cursor) VALUES(?,?,?,?,?,?,?,?,?)').bind(r.id,r.status,r.startedAt,r.completedAt,r.sourceCount,r.successCount,r.newCount,r.jobCount,r.processed ?? r.sourceCount).run();
        }
        await markDuplicates(db);
        await db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('seeded','true')").run();
      }
    })();
    ready.set(db,pending);
    pending.catch(()=>ready.delete(db));
  }
  await pending;
}
export function jobStatement(db: Database, job: Job): Statement {
  return db.prepare(`INSERT INTO jobs(id,source_id,company,title,location,country,work_mode,category,pay_min,pay_max,posted_at,first_seen_at,last_seen_at,apply_url,active,data)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,location=excluded.location,country=excluded.country,work_mode=excluded.work_mode,category=excluded.category,pay_min=excluded.pay_min,pay_max=excluded.pay_max,posted_at=COALESCE(excluded.posted_at,jobs.posted_at),last_seen_at=excluded.last_seen_at,apply_url=excluded.apply_url,active=1,data=excluded.data`)
    .bind(job.id,job.sourceId,job.company,job.title,job.location,job.country,job.workMode,job.category,job.payMin,job.payMax,job.postedAt,job.firstSeenAt,job.lastSeenAt,job.applyUrl,JSON.stringify(job));
}
export function hydrate(row: { data: string; first_seen_at?: string; last_seen_at?: string; posted_at?: string | null; active?: number } | any): Job {
  const j=JSON.parse(row.data) as Job;
  return {...j,firstSeenAt:row.firstSeenAt || row.first_seen_at || j.firstSeenAt,lastSeenAt:row.lastSeenAt || row.last_seen_at || j.lastSeenAt,postedAt:row.postedAt || row.posted_at || j.postedAt,active:(row.active ?? 1)===1};
}
// Stored LLM answers take precedence over the listing's regex skills and work
// mode. The raw listing in jobs.data is left alone, so enrichment hashes and
// embedding text still come from what the source published.
const ENRICHED_MODES:Record<string,Job['workMode']>={remote:'Remote',hybrid:'Hybrid',onsite:'On-site'};
const SENIORITY_LABELS=new Set(['intern','junior','mid','senior','lead','principal']);
export interface EnrichmentRow { job_id:string; skills:string; seniority:string; normalized_title:string; remote:string }
export function applyEnrichment(job: Job, row: EnrichmentRow | undefined): Job {
  if (!row) return job;
  const out:Job={...job};
  let skills:unknown=[];
  try { skills=JSON.parse(row.skills); } catch { /* a malformed list keeps the listed skills */ }
  const clean=Array.isArray(skills)?skills.filter((s):s is string=>typeof s==='string'&&s.trim()!==''):[];
  if (clean.length) { out.skills=clean; out.enriched=true; }
  const mode=ENRICHED_MODES[row.remote];
  if (mode) { out.workMode=mode; out.enriched=true; }
  if (SENIORITY_LABELS.has(row.seniority)) out.seniority=row.seniority as Job['seniority'];
  const title=row.normalized_title?.trim();
  if (title) out.normalizedTitle=title;
  return out;
}
// Older snapshots have no job_enrichment table. A missing table is checked
// again on the next call, since a writable database gains it in ensureDB.
const enrichmentTables=new WeakSet<Database>();
export async function hasEnrichment(db: Database): Promise<boolean> {
  if (enrichmentTables.has(db)) return true;
  const found=await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='job_enrichment'").first();
  if (found) enrichmentTables.add(db);
  return !!found;
}
// Stored answers keyed by role id, for the given roles or for every role.
export async function enrichmentRows(db: Database, ids?: string[]): Promise<Map<string,EnrichmentRow>> {
  const out=new Map<string,EnrichmentRow>();
  if ((ids && !ids.length) || !(await hasEnrichment(db))) return out;
  const columns='SELECT job_id,skills,seniority,normalized_title,remote FROM job_enrichment';
  const chunks=ids?Array.from({length:Math.ceil(ids.length/200)},(_,i)=>ids.slice(i*200,i*200+200)):[null];
  for (const chunk of chunks) {
    const statement=chunk?db.prepare(`${columns} WHERE job_id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk):db.prepare(columns);
    for (const row of (await statement.all<EnrichmentRow>()).results) out.set(row.job_id,row);
  }
  return out;
}
export async function withEnrichment(db: Database, jobs: Job[]): Promise<Job[]> {
  const rows=await enrichmentRows(db,jobs.map(j=>j.id));
  return jobs.map(j=>applyEnrichment(j,rows.get(j.id)));
}
// The work mode a visitor sees, as SQL, so filters and counts agree with the
// cards. prefix names the jobs table or its alias, such as 'jobs.' or 'j.'.
export async function workModeSql(db: Database, prefix='jobs.'): Promise<string> {
  if(prefix && !/^[a-z_]+\.$/.test(prefix))throw new Error('Invalid SQL prefix');
  if (!(await hasEnrichment(db))) return `${prefix}work_mode`;
  const cases=Object.entries(ENRICHED_MODES).map(([k,v])=>`WHEN '${k}' THEN '${v}'`).join(' ');
  return `COALESCE((SELECT CASE e.remote ${cases} END FROM job_enrichment e WHERE e.job_id=${prefix}id),${prefix}work_mode)`;
}
// One policy shared by listings, facets, detail URLs, and dashboard counts.
function baseScopeSql(prefix:string,now:Date):string {
  const title=`(' ' || lower(replace(replace(replace(replace(${prefix}title,'-',' '),'/',' '),'(',' '),')',' ')) || ' ')`;
  const terms=['software','developer','programmer','frontend','front end','backend','back end','full stack','fullstack','devops','devsecops','site reliability','sre','data','analytics','business intelligence','database','machine learning','deep learning','artificial intelligence','ai','ml','llm','nlp','computer vision','research','researcher','applied scientist','qa engineer','sdet','test automation','cloud engineer','platform engineer','bioinformatics','computational','statistician'];
  const related=terms.map(term=>`${title} LIKE '% ${term} %'`).join(' OR ');
  const permanent=PERMANENT_TYPES.map(t=>`'${t}'`).join(',');
  // Datacenter facilities and data-entry clerical work are outside this technical feed.
  return `${prefix}active=1 AND julianday(${prefix}posted_at)>=julianday('${feedCutoff(now).toISOString()}') AND julianday(${prefix}posted_at)<=julianday('${now.toISOString()}') AND (${related}) AND ${title} NOT LIKE '% data center %' AND ${title} NOT LIKE '% datacenter %' AND ${title} NOT LIKE '% data entry %' AND lower(trim(coalesce(json_extract(${prefix}data,'$.employmentType'),''))) NOT IN (${permanent})`;
}
// Reposted openings share a company, title and location. The newest posting
// in scope keeps the listing and every other in-scope copy is flagged.
function repostRankSql(now:Date):string {
  return `SELECT id,row_number() OVER (PARTITION BY company,lower(trim(title)),lower(trim(location)) ORDER BY posted_at DESC,id DESC) AS rank FROM jobs WHERE ${baseScopeSql('',now)}`;
}
// Stores the duplicate flag so feed requests can skip the window query.
// Returns how many rows are flagged after the update.
export async function markDuplicates(db: Database, now=new Date()): Promise<number> {
  await db.prepare(`UPDATE jobs SET duplicate=CASE WHEN id IN (SELECT id FROM (${repostRankSql(now)}) WHERE rank>1) THEN 1 ELSE 0 END`).run();
  const row=await db.prepare('SELECT count(*) AS n FROM jobs WHERE duplicate=1').first<{n:number}>();
  return Number(row?.n ?? 0);
}
// The original per-request scope that ranks reposts on the fly. The feed no
// longer runs it, but checks use it to confirm the stored flags still agree.
export function windowScopeSql(now=new Date()):string {
  return `(${baseScopeSql('',now)} AND id IN (SELECT id FROM (${repostRankSql(now)}) WHERE rank=1))`;
}
// Compares the stored flags with a fresh window query at the same moment.
// hidden lists roles the window query would show but the flags hide, and
// extra lists roles the flags show that the window query would collapse.
// Both are empty when the snapshot's flags are current.
export async function duplicateFlagDrift(db: Database, now=new Date()): Promise<{hidden:string[];extra:string[]}> {
  const ids=async(where:string)=>new Set((await db.prepare(`SELECT id FROM jobs WHERE ${where}`).all<{id:string}>()).results.map(r=>r.id));
  const [stored,window]=await Promise.all([ids(feedScopeSql('',now)),ids(windowScopeSql(now))]);
  return {hidden:[...window].filter(id=>!stored.has(id)).sort(),extra:[...stored].filter(id=>!window.has(id)).sort()};
}
export function feedScopeSql(alias='' , now=new Date()):string {
  if(alias && !/^[a-z_]+$/.test(alias))throw new Error('Invalid SQL alias');
  const prefix=alias?alias+'.':'';
  // Sources often repost one opening under several requisition IDs. Only the
  // newest posting per company, title and location is listed. markDuplicates
  // stores that choice after every refresh and build, so requests read a
  // column here instead of ranking the whole table.
  return `(${baseScopeSql(prefix,now)} AND ${prefix}duplicate=0)`;
}
// Drizzle builds the feed queries and hands the SQL to this callback, which
// expects rows as arrays of column values in select order.
export function drizzleFor(db: Database) {
  return drizzle(async(query,params,method)=> {
    const statement=db.prepare(query).bind(...params);
    if (method==='run') { await statement.run(); return {rows:[]}; }
    const rows=await statement.raw();
    return {rows:method==='get'?rows[0] as any:rows};
  });
}
// The feed scope plus every filter in the query string. A semantic search
// ranks by meaning instead of matching the text, so it leaves q out.
export async function feedFilters(db: Database, p: URLSearchParams, options: { textQuery?: boolean } = {}) {
  const j=schema.jobs;
  const active=and(sql.raw(feedScopeSql()),inArray(j.sourceId,SOURCES.map(s=>s.id)))!;
  const filters=[active];
  const query=options.textQuery===false?'':p.get('q')?.trim().slice(0,150);
  if (query) { const term=`%${query.replace(/[\\%_]/g,'\\$&')}%`; filters.push(sql`(${j.title} LIKE ${term} ESCAPE '\\' OR ${j.company} LIKE ${term} ESCAPE '\\' OR ${j.location} LIKE ${term} ESCAPE '\\' OR ${j.data} LIKE ${term} ESCAPE '\\')`); }
  if (p.get('location')) filters.push(like(j.location,`%${p.get('location')!.slice(0,100)}%`));
  for (const [key,column] of [['company',j.company],['category',j.category],['country',j.country]] as const) {
    const values=p.getAll(key).filter(Boolean); if(values.length) filters.push(inArray(column,values.slice(0,60)));
  }
  const modes=p.getAll('mode').filter(Boolean);
  if (modes.length) filters.push(inArray(sql.raw(await workModeSql(db)),modes.slice(0,60)));
  const freshness=p.get('freshness');
  if (['24h','7d','30d'].includes(freshness || '')) {
    const hours=freshness==='24h'?24:freshness==='7d'?168:720;
    // Missing posting dates are not labelled as new postings.
    filters.push(sql`${j.postedAt} >= ${new Date(Date.now()-hours*3_600_000).toISOString()}`);
  }
  if (p.get('pay')==='yes') filters.push(sql`(${j.payMin} IS NOT NULL OR ${j.payMax} IS NOT NULL)`);
  if (p.get('sort')==='pay') filters.push(sql`json_extract(${j.data}, '$.currency') = 'USD' AND lower(json_extract(${j.data}, '$.payPeriod')) IN ('hour','hourly','hr') AND (${j.payMin} IS NOT NULL OR ${j.payMax} IS NOT NULL)`);
  const ids=p.getAll('id'); if(ids.length) filters.push(inArray(j.id,ids.slice(0,250)));
  return {active,where:and(...filters)!};
}
// Company, category and country values across the whole feed, for the filter menus.
export async function feedFacets(db: Database, active: SQL): Promise<Feed['facets']> {
  const orm=drizzleFor(db),j=schema.jobs;
  const [companies,categories,countries]=await Promise.all([
    orm.select({name:j.company,count:sql<number>`count(*)`}).from(j).where(active).groupBy(j.company).orderBy(j.company),
    orm.select({name:j.category,count:sql<number>`count(*)`}).from(j).where(active).groupBy(j.category).orderBy(j.category),
    orm.select({country:j.country}).from(j).where(active).groupBy(j.country).orderBy(j.country),
  ]);
  return {companies,categories,countries:countries.map(r=>r.country)};
}
export const FEED_PAGE_SIZE=18;
export async function jobFeed(db: Database, p: URLSearchParams): Promise<Feed> {
  const orm=drizzleFor(db),j=schema.jobs;
  const {active,where}=await feedFilters(db,p);
  const limit=FEED_PAGE_SIZE;
  const count=await orm.select({count:sql<number>`count(*)`}).from(j).where(where);
  const total=Number(count[0]?.count||0), pages=Math.max(1,Math.ceil(total/limit));
  const page=Math.min(pages,Math.max(1,Math.floor(Number(p.get('page'))||1)));
  const order=p.get('sort')==='company'?[j.company,desc(j.postedAt)]:p.get('sort')==='pay'?[desc(j.payMax),desc(j.payMin)]:p.get('sort')==='discovered'?[desc(j.firstSeenAt)]:[desc(j.postedAt),desc(j.firstSeenAt)];
  const rows=await orm.select().from(j).where(where).orderBy(...order).limit(limit).offset((page-1)*limit);
  return {jobs:await withEnrichment(db,rows.map(hydrate)),total,page,pages,facets:await feedFacets(db,active)};
}
const retiredSql=RETIRED_SOURCE_IDS.map(()=>'?').join(',');
// One role from the public feed, or null when it is outside the feed policy.
export async function getFeedJob(db: Database, id: string): Promise<Job | null> {
  const row=await db.prepare(`SELECT * FROM jobs WHERE id=? AND ${feedScopeSql()} AND source_id NOT IN (${retiredSql})`).bind(id,...RETIRED_SOURCE_IDS).first();
  if (!row) return null;
  const [job]=await withEnrichment(db,[hydrate(row)]);
  return job;
}
// The source directory with live role counts, as shown on the site.
export async function listSources(db: Database): Promise<Source[]> {
  const result=await db.prepare(`SELECT s.*, c.complete,c.advertised_count,c.fetched_count, (SELECT count(*) FROM jobs j WHERE j.source_id=s.id AND ${feedScopeSql('j')}) AS job_count FROM sources s LEFT JOIN source_coverage c ON c.source_id=s.id WHERE s.id NOT IN (${retiredSql}) ORDER BY s.company`).bind(...RETIRED_SOURCE_IDS).all<any>();
  return result.results.map(r=>({id:r.id,company:r.company,provider:r.provider,url:r.url,country:r.country,status:r.status,lastCheckedAt:r.last_checked_at,lastSuccessAt:r.last_success_at,jobCount:r.job_count,message:r.message,coverage:r.status==='healthy'?(r.complete===1?'complete':'partial'):'unavailable',empty:r.status==='healthy'&&Number(r.job_count)===0,advertisedCount:r.advertised_count??null,fetchedCount:r.fetched_count??null}));
}
export interface SourceHealth { total:number; healthy:number; complete:number; partial:number; empty:number }
// Source counts for the overview. A readable source only counts as loaded when it has roles in the feed.
export function sourceHealth(sources: Source[]): SourceHealth {
  const loaded=sources.filter(s=>s.status==='healthy'&&!s.empty);
  const complete=loaded.filter(s=>s.coverage==='complete').length;
  return {total:sources.length,healthy:loaded.length,complete,partial:loaded.length-complete,empty:sources.filter(s=>s.empty).length};
}
