import { DatabaseSync } from 'node:sqlite';
import { describe,it,expect } from 'vitest';
import worker from '../server/index';
import { ensureDB,jobStatement } from '../server/db';
import { startRun } from '../server/ingestion';
import { makeJob } from '../server/normalize';
import { SOURCES } from '../server/sources';

function sqliteD1(): D1Database {
  const db=new DatabaseSync(':memory:');
  const prepare=(query:string)=> {
    let values:any[]=[];
    const statement={
      bind(...params:any[]){values=params;return statement;},
      async first(column?:string){const row=db.prepare(query).get(...values);return column?row?.[column]:row||null;},
      async all(){const result=db.prepare(query).all(...values);return {results:result,success:true,meta:{}};},
      async raw(){const s=db.prepare(query);s.setReturnArrays(true);return s.all(...values);},
      async run(){const r=db.prepare(query).run(...values);return {success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
    };return statement;
  };
  return {prepare,async batch(statements:any[]){return Promise.all(statements.map(s=>s.all()));},async exec(query:string){db.exec(query);return {count:0,duration:0};}} as unknown as D1Database;
}
const ctx={waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext;
async function request(db:D1Database,path:string,options?:RequestInit){return worker.fetch(new Request('https://atlas.test'+path,options),{DB:db,ASSETS:{fetch:async()=>new Response('static')} as any},ctx);}
describe('database-backed API',()=> {
  it('provides pagination, multi-filter intersections, and safe literal search',async()=> {
    const db=sqliteD1();await ensureDB(db);
    const response=await request(db,'/api/jobs?mode=Remote&category=Engineering+%26+IT');
    expect(response.status).toBe(200);const data=await response.json() as any;
    expect(data.jobs.every((j:any)=>j.workMode==='Remote'&&j.category==='Engineering & IT')).toBe(true);expect(data.jobs.length).toBeLessThanOrEqual(18);
    const malicious=await request(db,"/api/jobs?q=%27%20OR%201%3D1%20--");expect((await malicious.json() as any).total).toBe(0);
  });
  it('upserts without creating duplicate roles or resetting first discovery',async()=> {
    const db=sqliteD1();await ensureDB(db);const s=SOURCES[0];
    const first=makeJob(s,{sourceJobId:'stable-id',title:'Data Engineer',applyUrl:'https://us.meta.talentnet.community/jobs/stable-id'},'2026-09-01T00:00:00.000Z')!;
    await jobStatement(db,first).run();await jobStatement(db,{...first,title:'Senior Data Engineer',firstSeenAt:'2026-09-30T00:00:00.000Z',lastSeenAt:'2026-09-30T00:00:00.000Z'}).run();
    const r=await request(db,'/api/jobs?id=meta%3Astable-id');const d=await r.json() as any;
    expect(d.total).toBe(1);expect(d.jobs[0].title).toBe('Senior Data Engineer');expect(d.jobs[0].firstSeenAt).toBe('2026-09-01T00:00:00.000Z');expect(d.jobs[0].lastSeenAt).toBe('2026-09-30T00:00:00.000Z');
  });
  it('hides archived restricted sources and roles without deleting history',async()=> {
    const db=sqliteD1();await ensureDB(db);
    await db.prepare("INSERT OR IGNORE INTO sources(id,company,provider,url,country,status) VALUES('adm','ADM','LiveHire','https://example.com','US','blocked')").run();
    const job=makeJob({...SOURCES[0],id:'adm',company:'ADM'},{sourceJobId:'archived',title:'Archived Analyst',applyUrl:'https://example.com/jobs/1'},'2026-09-01T00:00:00Z')!;
    await jobStatement(db,job).run();
    expect((await (await request(db,'/api/jobs?company=ADM')).json() as any).total).toBe(0);
    expect((await request(db,'/api/jobs/adm:archived')).status).toBe(404);
    expect((await (await request(db,'/api/sources')).json() as any[]).some(s=>s.id==='adm')).toBe(false);
    expect((await (await request(db,'/api/overview')).json() as any).sourceCount).toBe(57);
    expect(await db.prepare("SELECT id FROM sources WHERE id='adm'").first()).toBeTruthy();
  });
  it('shares a refresh run across repeated triggers',async()=> {
    const db=sqliteD1();await ensureDB(db);const a=await startRun(db),b=await startRun(db);expect(a.id).toBe(b.id);
  });
  it('blocks cross-origin writes and exposes original source health',async()=> {
    const db=sqliteD1();const bad=await request(db,'/api/refresh',{method:'POST',headers:{Origin:'https://untrusted.example'}});expect(bad.status).toBe(403);
    const response=await request(db,'/api/sources');const sources=await response.json() as any[];expect(sources).toHaveLength(57);expect(sources.every(s=>typeof s.status==='string')).toBe(true);
  });
  it('distinguishes fully retrieved feeds from readable but partial feeds',async()=>{
    const db=sqliteD1();await ensureDB(db);
    await db.prepare("UPDATE sources SET status='error'").run();
    await db.prepare("UPDATE sources SET status='healthy' WHERE id IN ('meta','pinterest')").run();
    await db.prepare("INSERT INTO source_coverage(source_id,complete,advertised_count,fetched_count,checked_at) VALUES('meta',1,298,298,?) ON CONFLICT(source_id) DO UPDATE SET complete=1,advertised_count=298,fetched_count=298").bind('2026-09-30T22:00:00.000Z').run();
    await db.prepare("INSERT INTO source_coverage(source_id,complete,fetched_count,checked_at) VALUES('pinterest',0,1,?) ON CONFLICT(source_id) DO UPDATE SET complete=0").bind('2026-09-30T22:00:00.000Z').run();
    const rows=await (await request(db,'/api/sources')).json() as any[];
    expect(rows.find(s=>s.id==='meta')).toMatchObject({coverage:'complete',advertisedCount:298,fetchedCount:298});
    expect(rows.find(s=>s.id==='pinterest').coverage).toBe('partial');
    expect(rows.find(s=>s.id==='boeing').coverage).toBe('unavailable');
    const overview=await (await request(db,'/api/overview')).json() as any;
    expect(overview).toMatchObject({healthySources:2,completeSources:1,partialSources:1});
  });
});
