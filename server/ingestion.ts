import { SOURCES } from './sources.js';
import { collectSource, type Collection } from './adapters.js';
import { jobStatement } from './db.js';
import type { Run } from '../src/types.js';

type RunRow = {id:string;status:Run['status'];started_at:string;completed_at:string|null;source_count:number;success_count:number;new_count:number;job_count:number;cursor:number};
export function formatRun(row:RunRow): Run & { processed: number } {
  return {id:row.id,status:row.status,startedAt:row.started_at,completedAt:row.completed_at,sourceCount:row.source_count,successCount:row.success_count,newCount:row.new_count,jobCount:row.job_count,processed:row.cursor};
}
async function lease(db:D1Database,key:string,owner:string,seconds:number):Promise<boolean> {
  const now=Math.floor(Date.now()/1000);
  const row=await db.prepare('INSERT INTO leases(key,owner,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<? RETURNING key').bind(key,owner,now+seconds,now).first();
  return !!row;
}
export async function startRun(db:D1Database):Promise<Run & {processed:number}> {
  const running=await db.prepare("SELECT * FROM runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").first<RunRow>();
  if(running && Date.now()-Date.parse(running.started_at)<1_800_000) return formatRun(running);
  const id=crypto.randomUUID(),now=new Date().toISOString();
  if(!await lease(db,'ingestion',id,1800)) throw new Error('A refresh is already in progress.');
  if(running) await db.prepare("UPDATE runs SET status='failed',completed_at=? WHERE id=?").bind(now,running.id).run();
  await db.prepare("INSERT INTO runs(id,status,started_at,source_count) VALUES(?,'running',?,?)").bind(id,now,SOURCES.length).run();
  return formatRun((await db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>())!);
}
async function boundedCollect(index:number,now:string):Promise<Collection> {
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<Collection>(resolve=> {timer=setTimeout(()=>resolve({jobs:[],status:'error',message:'Source collection timed out; previous listings were retained.',complete:false}),120_000);});
  try {return await Promise.race([collectSource(SOURCES[index],now),deadline]);} finally {clearTimeout(timer!);}
}
export async function stepRun(db:D1Database,id:string):Promise<Run & {processed:number}> {
  const row=await db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();
  if(!row) throw new Error('Refresh run not found.');
  if(row.status!=='running') return formatRun(row);
  const owner=crypto.randomUUID();
  if(!await lease(db,`step:${id}`,owner,150)) return formatRun(row);
  try {
    const now=new Date().toISOString(),batch=SOURCES.slice(row.cursor,row.cursor+1);
    const results=await Promise.all(batch.map((_,i)=>boundedCollect(row.cursor+i,now)));
    let success=0,newCount=0,jobCount=0;
    for(let i=0;i<batch.length;i++) {
      const source=batch[i],result=results[i];
      if(result.status==='healthy') success++;
      const existing=await db.prepare('SELECT id,data FROM jobs WHERE source_id=?').bind(source.id).all<{id:string;data:string}>();
      const known=new Set(existing.results.map(j=>j.id));
      const previous=new Map(existing.results.map(j=>[j.id,JSON.parse(j.data)]));
      // A full listing card need not expose every detail field. Keep previously
      // collected descriptions rather than replacing them with blank strings.
      for(const job of result.jobs) {
        const prior=previous.get(job.id);
        if(prior && !job.description)job.description=prior.description || '';
      }
      if(result.retireExisting)await db.prepare('UPDATE jobs SET active=0 WHERE source_id=?').bind(source.id).run();
      newCount+=result.jobs.filter(j=>!known.has(j.id)).length;
      jobCount+=result.jobs.length;
      for(let offset=0;offset<result.jobs.length;offset+=25) await db.batch(result.jobs.slice(offset,offset+25).map(j=>jobStatement(db,j)));
      await db.prepare('UPDATE sources SET status=?,last_checked_at=?,last_success_at=CASE WHEN ?=\'healthy\' THEN ? ELSE last_success_at END,message=? WHERE id=?').bind(result.status,now,result.status,now,result.message,source.id).run();
      await db.prepare('INSERT INTO source_coverage(source_id,complete,advertised_count,fetched_count,checked_at) VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET complete=excluded.complete,advertised_count=excluded.advertised_count,fetched_count=excluded.fetched_count,checked_at=excluded.checked_at').bind(source.id,result.complete&&result.status==='healthy'?1:0,result.advertisedCount??null,result.retrievedCount??result.jobs.length,now).run();
      if(result.complete && result.status==='healthy') {
        const cutoff=new Date(Date.now()-48*3_600_000).toISOString();
        await db.prepare('UPDATE jobs SET active=0 WHERE source_id=? AND last_seen_at<?').bind(source.id,cutoff).run();
      }
    }
    const cursor=row.cursor+batch.length,done=cursor>=SOURCES.length;
    const status=done?(row.success_count+success===SOURCES.length?'completed':row.success_count+success>0?'partial':'failed'):'running';
    await db.prepare('UPDATE runs SET cursor=?,success_count=success_count+?,new_count=new_count+?,job_count=job_count+?,status=?,completed_at=? WHERE id=? AND cursor=?').bind(cursor,success,newCount,jobCount,status,done?now:null,id,row.cursor).run();
    if(done) await db.prepare('DELETE FROM leases WHERE key=\'ingestion\' AND owner=?').bind(id).run();
    return formatRun((await db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>())!);
  } finally {await db.prepare('DELETE FROM leases WHERE key=? AND owner=?').bind(`step:${id}`,owner).run();}
}
export async function runScheduled(db:D1Database):Promise<Run> {
  let run=await startRun(db);
  while(run.status==='running') {
    const processed=run.processed;
    run=await stepRun(db,run.id);
    if(run.status==='running' && run.processed===processed) await new Promise(r=>setTimeout(r,1000));
  }
  return run;
}
