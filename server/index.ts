import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { ensureDB, hydrate, jobFeed } from './db.js';
import { formatRun, startRun, stepRun, runScheduled } from './ingestion.js';
import type { Overview, Source } from '../src/types.js';

type Bindings={DB:D1Database;ASSETS:Fetcher};
const app=new Hono<{Bindings:Bindings}>();
app.use('*',secureHeaders({referrerPolicy:'strict-origin-when-cross-origin',xFrameOptions:false}));
app.use('/api/*',bodyLimit({maxSize:16_384}));
app.use('/api/*',async(c,next)=> {
  c.header('Cache-Control','no-store');
  if(c.req.method!=='GET') {
    const origin=c.req.header('Origin');
    if(origin && origin!==new URL(c.req.url).origin) return c.json({error:'Cross-origin mutations are not allowed.'},403);
  }
  await ensureDB(c.env.DB);
  await next();
});
app.get('/api/access',c=>c.json({canRefresh:true}));
app.get('/api/health',c=>c.json({ok:true,service:'contract-atlas',timestamp:new Date().toISOString()}));
app.get('/api/jobs',async c=>c.json(await jobFeed(c.env.DB,new URL(c.req.url).searchParams)));
app.get('/api/jobs/:id',async c=> {
  const row=await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(c.req.param('id')).first();
  return row?c.json(hydrate(row)):c.json({error:'Role not found.'},404);
});
app.get('/api/sources',async c=> {
  const result=await c.env.DB.prepare(`SELECT s.*, c.complete,c.advertised_count,c.fetched_count, (SELECT count(*) FROM jobs j WHERE j.source_id=s.id AND j.active=1) AS job_count FROM sources s LEFT JOIN source_coverage c ON c.source_id=s.id ORDER BY s.company`).all<any>();
  const rows:Source[]=result.results.map(r=>({id:r.id,company:r.company,provider:r.provider,url:r.url,country:r.country,status:r.status,lastCheckedAt:r.last_checked_at,lastSuccessAt:r.last_success_at,jobCount:r.job_count,message:r.message,coverage:r.status==='healthy'?(r.complete===1?'complete':'partial'):'unavailable',advertisedCount:r.advertised_count??null,fetchedCount:r.fetched_count??null}));
  return c.json(rows);
});
app.get('/api/overview',async c=> {
  const db=c.env.DB,today=new Date(Date.now()-24*3_600_000).toISOString();
  const [stats,sourceStats,last,schedule]=await Promise.all([
    db.prepare('SELECT count(*) AS total, sum(CASE WHEN posted_at>=? THEN 1 ELSE 0 END) AS today, sum(CASE WHEN work_mode=\'Remote\' THEN 1 ELSE 0 END) AS remote, count(DISTINCT company) AS companies FROM jobs WHERE active=1').bind(today).first<any>(),
    db.prepare('SELECT count(*) AS total,sum(CASE WHEN s.status=\'healthy\' THEN 1 ELSE 0 END) AS healthy,sum(CASE WHEN s.status=\'healthy\' AND c.complete=1 THEN 1 ELSE 0 END) AS complete FROM sources s LEFT JOIN source_coverage c ON c.source_id=s.id').first<any>(),
    db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').first<any>(),
    db.prepare("SELECT value FROM settings WHERE key='schedule_enabled'").first<{value:string}>(),
  ]);
  const enabled=schedule?.value==='true';
  const overview:Overview={totalJobs:stats?.total||0,newToday:stats?.today||0,remoteJobs:stats?.remote||0,companyCount:stats?.companies||0,sourceCount:sourceStats?.total||0,healthySources:sourceStats?.healthy||0,completeSources:sourceStats?.complete||0,partialSources:(sourceStats?.healthy||0)-(sourceStats?.complete||0),lastRun:last?formatRun(last):null,nextRefreshAt:enabled?new Date((Math.floor((Date.now()-17*60_000)/7_200_000)+1)*7_200_000+17*60_000).toISOString():null,scheduleEnabled:enabled};
  return c.json(overview);
});
app.get('/api/runs',async c=> {const rows=await c.env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 20').all<any>();return c.json(rows.results.map(formatRun));});
app.post('/api/refresh',async c=>c.json(await startRun(c.env.DB),202));
app.post('/api/refresh/:id/step',async c=> {
  if(!/^[a-f0-9-]{36}$/.test(c.req.param('id'))) return c.json({error:'Invalid refresh ID.'},400);
  return c.json(await stepRun(c.env.DB,c.req.param('id')));
});
app.post('/api/settings/schedule',async c=> {
  const body=await c.req.json<{enabled:boolean}>();
  if(typeof body.enabled!=='boolean') return c.json({error:'enabled must be a boolean.'},400);
  await c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('schedule_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(body.enabled)).run();
  return c.json({enabled:body.enabled});
});
app.all('/api/*',c=>c.json({error:'API endpoint not found.'},404));
app.all('*',c=>c.env.ASSETS.fetch(c.req.raw));
app.onError((error,c)=> {
  console.error(JSON.stringify({level:'error',message:error.message,path:c.req.path,timestamp:new Date().toISOString()}));
  const message=error.message.includes('already in progress')?error.message:'The request could not complete. Try again shortly.';
  return c.json({error:message},error.message.includes('already in progress')?409:503);
});
export default {
  fetch:app.fetch,
  async scheduled(_event:ScheduledController,env:Bindings,ctx:ExecutionContext) {
    ctx.waitUntil((async()=> {await ensureDB(env.DB);await runScheduled(env.DB);})());
  },
};
