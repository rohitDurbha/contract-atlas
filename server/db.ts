import { drizzle } from 'drizzle-orm/d1';
import { and, eq, like, or, sql, desc, inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import { SOURCES } from './sources.js';
import seed from './seed.json' with { type: 'json' };
import type { Job, Feed } from '../src/types.js';

const DDL = [
  'CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY,company TEXT NOT NULL,provider TEXT NOT NULL,url TEXT NOT NULL,country TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'pending\',last_checked_at TEXT,last_success_at TEXT,message TEXT)',
  'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,company TEXT NOT NULL,title TEXT NOT NULL,location TEXT NOT NULL,country TEXT NOT NULL,work_mode TEXT NOT NULL,category TEXT NOT NULL,pay_min REAL,pay_max REAL,posted_at TEXT,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,apply_url TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,UNIQUE(source_id,apply_url))',
  'CREATE INDEX IF NOT EXISTS jobs_freshness ON jobs(active,posted_at DESC,first_seen_at DESC)',
  'CREATE INDEX IF NOT EXISTS jobs_filters ON jobs(company,category,work_mode)',
  'CREATE INDEX IF NOT EXISTS jobs_sources ON jobs(source_id,active,last_seen_at)',
  'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,status TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,source_count INTEGER NOT NULL DEFAULT 0,success_count INTEGER NOT NULL DEFAULT 0,new_count INTEGER NOT NULL DEFAULT 0,job_count INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS source_coverage (source_id TEXT PRIMARY KEY,complete INTEGER NOT NULL DEFAULT 0,advertised_count INTEGER,fetched_count INTEGER NOT NULL DEFAULT 0,checked_at TEXT NOT NULL)',
];
const ready = new WeakMap<D1Database, Promise<void>>();
export async function ensureDB(db: D1Database): Promise<void> {
  if (!db) throw new Error('The database binding is unavailable.');
  if ((db as D1Database & {readOnly?:boolean}).readOnly) return;
  let pending=ready.get(db);
  if (!pending) {
    pending=(async()=> {
      await db.batch(DDL.map(s=>db.prepare(s)));
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
        await db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('seeded','true')").run();
      }
    })();
    ready.set(db,pending);
    pending.catch(()=>ready.delete(db));
  }
  await pending;
}
export function jobStatement(db: D1Database, job: Job): D1PreparedStatement {
  return db.prepare(`INSERT INTO jobs(id,source_id,company,title,location,country,work_mode,category,pay_min,pay_max,posted_at,first_seen_at,last_seen_at,apply_url,active,data)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,location=excluded.location,country=excluded.country,work_mode=excluded.work_mode,category=excluded.category,pay_min=excluded.pay_min,pay_max=excluded.pay_max,posted_at=COALESCE(excluded.posted_at,jobs.posted_at),last_seen_at=excluded.last_seen_at,apply_url=excluded.apply_url,active=1,data=excluded.data`)
    .bind(job.id,job.sourceId,job.company,job.title,job.location,job.country,job.workMode,job.category,job.payMin,job.payMax,job.postedAt,job.firstSeenAt,job.lastSeenAt,job.applyUrl,JSON.stringify(job));
}
export function hydrate(row: { data: string; first_seen_at?: string; last_seen_at?: string; posted_at?: string | null; active?: number } | any): Job {
  const j=JSON.parse(row.data) as Job;
  return {...j,firstSeenAt:row.firstSeenAt || row.first_seen_at || j.firstSeenAt,lastSeenAt:row.lastSeenAt || row.last_seen_at || j.lastSeenAt,postedAt:row.postedAt || row.posted_at || j.postedAt,active:(row.active ?? 1)===1};
}
export async function jobFeed(db: D1Database, p: URLSearchParams): Promise<Feed> {
  const orm=drizzle(db),j=schema.jobs;
  const filters=[eq(j.active,1)];
  const query=p.get('q')?.trim().slice(0,150);
  if (query) { const term=`%${query.replace(/[\\%_]/g,'\\$&')}%`; filters.push(sql`(${j.title} LIKE ${term} ESCAPE '\\' OR ${j.company} LIKE ${term} ESCAPE '\\' OR ${j.location} LIKE ${term} ESCAPE '\\' OR ${j.data} LIKE ${term} ESCAPE '\\')`); }
  if (p.get('location')) filters.push(like(j.location,`%${p.get('location')!.slice(0,100)}%`));
  for (const [key,column] of [['company',j.company],['category',j.category],['mode',j.workMode],['country',j.country]] as const) {
    const values=p.getAll(key).filter(Boolean); if(values.length) filters.push(inArray(column,values.slice(0,60)));
  }
  const freshness=p.get('freshness');
  if (['24h','7d','30d'].includes(freshness || '')) {
    const hours=freshness==='24h'?24:freshness==='7d'?168:720;
    // Missing posting dates are not labelled as new postings.
    filters.push(sql`${j.postedAt} >= ${new Date(Date.now()-hours*3_600_000).toISOString()}`);
  }
  if (p.get('pay')==='yes') filters.push(sql`(${j.payMin} IS NOT NULL OR ${j.payMax} IS NOT NULL)`);
  if (p.get('sort')==='pay') filters.push(sql`json_extract(${j.data}, '$.currency') = 'USD' AND lower(json_extract(${j.data}, '$.payPeriod')) IN ('hour','hourly','hr') AND (${j.payMin} IS NOT NULL OR ${j.payMax} IS NOT NULL)`);
  const ids=p.getAll('id'); if(ids.length) filters.push(inArray(j.id,ids.slice(0,250)));
  const where=and(...filters),limit=18;
  const count=await orm.select({count:sql<number>`count(*)`}).from(j).where(where);
  const total=Number(count[0]?.count||0), pages=Math.max(1,Math.ceil(total/limit));
  const page=Math.min(pages,Math.max(1,Math.floor(Number(p.get('page'))||1)));
  const order=p.get('sort')==='company'?[j.company,desc(j.postedAt)]:p.get('sort')==='pay'?[desc(j.payMax),desc(j.payMin)]:p.get('sort')==='discovered'?[desc(j.firstSeenAt)]:[desc(j.postedAt),desc(j.firstSeenAt)];
  const rows=await orm.select().from(j).where(where).orderBy(...order).limit(limit).offset((page-1)*limit);
  const [companies,categories,countries]=await Promise.all([
    orm.select({name:j.company,count:sql<number>`count(*)`}).from(j).where(eq(j.active,1)).groupBy(j.company).orderBy(j.company),
    orm.select({name:j.category,count:sql<number>`count(*)`}).from(j).where(eq(j.active,1)).groupBy(j.category).orderBy(j.category),
    orm.select({country:j.country}).from(j).where(eq(j.active,1)).groupBy(j.country).orderBy(j.country),
  ]);
  return {jobs:rows.map(hydrate),total,page,pages,facets:{companies,categories,countries:countries.map(r=>r.country)}};
}
