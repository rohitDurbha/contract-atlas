import { RETIRED_SOURCE_IDS } from './sources.js';
const retiredSql=RETIRED_SOURCE_IDS.map(()=>'?').join(',');
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { ensureDB, jobFeed, feedScopeSql, getFeedJob, listSources, sourceHealth, workModeSql } from './db.js';
import { formatRun } from './ingestion.js';
import type { Overview } from '../src/types.js';
import type { Database } from './database.js';

// The site and the MCP endpoint are served from a read-only snapshot. Collection
// runs in GitHub Actions, so this app exposes no write routes.
type Bindings={DB:Database};
const app=new Hono<{Bindings:Bindings}>();
app.use('*',secureHeaders({referrerPolicy:'strict-origin-when-cross-origin',xFrameOptions:false}));
app.use('/api/*',bodyLimit({maxSize:16_384}));
app.use('/api/*',async(c,next)=> {
  c.header('Cache-Control','no-store');
  await ensureDB(c.env.DB);
  await next();
});
app.get('/api/access',c=>c.json({canRefresh:false}));
app.get('/api/health',c=>c.json({ok:true,service:'contract-atlas',timestamp:new Date().toISOString()}));
app.get('/api/jobs',async c=>c.json(await jobFeed(c.env.DB,new URL(c.req.url).searchParams)));
app.get('/api/jobs/:id',async c=> {
  const job=await getFeedJob(c.env.DB,c.req.param('id'));
  return job?c.json(job):c.json({error:'Role not found.'},404);
});
app.get('/api/sources',async c=>c.json(await listSources(c.env.DB)));
app.get('/api/overview',async c=> {
  const db=c.env.DB,today=new Date(Date.now()-24*3_600_000).toISOString();
  const mode=await workModeSql(db);
  const [stats,sourceStats,last,schedule]=await Promise.all([
    db.prepare(`SELECT count(*) AS total, sum(CASE WHEN posted_at>=? THEN 1 ELSE 0 END) AS today, sum(CASE WHEN ${mode}=\'Remote\' THEN 1 ELSE 0 END) AS remote, count(DISTINCT company) AS companies FROM jobs WHERE ${feedScopeSql()} AND source_id NOT IN (${retiredSql})`).bind(today,...RETIRED_SOURCE_IDS).first<any>(),
    listSources(db).then(sourceHealth),
    db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').first<any>(),
    db.prepare("SELECT value FROM settings WHERE key='schedule_enabled'").first<{value:string}>(),
  ]);
  const enabled=schedule?.value==='true';
  const overview:Overview={totalJobs:stats?.total||0,newToday:stats?.today||0,remoteJobs:stats?.remote||0,companyCount:stats?.companies||0,sourceCount:sourceStats.total,healthySources:sourceStats.healthy,completeSources:sourceStats.complete,partialSources:sourceStats.partial,emptySources:sourceStats.empty,lastRun:last?formatRun(last):null,nextRefreshAt:enabled&&last?new Date(Math.max(Date.parse(last.started_at)+7_200_000,Date.now())).toISOString():null,scheduleEnabled:enabled};
  return c.json(overview);
});
app.get('/api/runs',async c=> {const rows=await c.env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 20').all<any>();return c.json(rows.results.map(formatRun));});
app.all('/api/*',c=>c.json({error:'API endpoint not found.'},404));
app.all('*',c=>c.json({error:'Not found.'},404));
app.onError((error,c)=> {
  console.error(JSON.stringify({level:'error',message:error.message,path:c.req.path,timestamp:new Date().toISOString()}));
  return c.json({error:'The request could not complete. Try again shortly.'},503);
});
export default {fetch:app.fetch};
