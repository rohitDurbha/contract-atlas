import { SOURCES } from '../server/sources';
import { resolve } from 'node:path';
import { openSQLite } from '../server/sqlite';
import { freeFetch } from '../server/free-runtime';
import { readFile } from 'node:fs/promises';
import { isPayModel } from '../server/pay-model';
import { duplicateFlagDrift } from '../server/db';
import { enrichmentProblems } from '../server/enrichment';
const {db,close}=openSQLite(resolve('data/atlas.sqlite'),true);
try {
  const integrity=await db.prepare('PRAGMA quick_check').first<string>('quick_check');
  if(integrity!=='ok')throw new Error('Snapshot integrity check failed; publishing stopped.');
  const invalid=await db.prepare("SELECT count(*) n FROM jobs WHERE NOT json_valid(data) OR trim(title)='' OR apply_url NOT LIKE 'https://%'").first<any>();
  if(invalid.n)throw new Error('Snapshot contains malformed job records; publishing stopped.');
  // The feed trusts the stored repost flags, so a snapshot whose flags
  // disagree with a fresh window query would list or hide the wrong roles.
  const drift=await duplicateFlagDrift(db);
  if(drift.hidden.length||drift.extra.length)throw new Error(`Stored repost flags disagree with the window query (${drift.hidden.length} hidden, ${drift.extra.length} extra, for example ${[...drift.hidden,...drift.extra].slice(0,3).join(', ')}); publishing stopped.`);
  const feedIndex=await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='jobs_feed'").first();
  if(!feedIndex)throw new Error('Snapshot is missing the jobs_feed index; publishing stopped.');
  const listed=await db.prepare("SELECT count(*) n FROM jobs WHERE duplicate=1").first<any>();
  console.log(JSON.stringify({repostFlags:'current',flagged:listed.n}));
  // Stored LLM answers are read straight into feed cards and MCP results,
  // so a malformed row would show odd labels or pay to every visitor.
  const enrichment=await enrichmentProblems(db);
  if(enrichment.length)throw new Error(`Stored enrichment is malformed (${enrichment.length} problems, for example ${enrichment.slice(0,3).map(p=>`${p.jobId} ${p.problem}`).join('; ')}); publishing stopped.`);
  const enriched=await db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='job_enrichment'").first<any>();
  console.log(JSON.stringify({enrichment:enriched.n?'valid':'absent',rows:enriched.n?(await db.prepare('SELECT count(*) n FROM job_enrichment').first<any>()).n:0}));
  const fetcher=freeFetch(db);
  for(const path of ['/api/overview','/api/sources','/api/jobs?q=Data%20Labeling%20Analyst','/api/jobs?page=2','/api/jobs?sort=pay']) {
    const response=await fetcher(new Request('https://atlas.test'+path));if(response.status!==200)throw new Error(`Snapshot verification failed: ${path}`);
    const data=await response.json() as any;
    if(path==='/api/sources'&&data.length!==SOURCES.length)throw new Error('Source registry incomplete.');
    if(path==='/api/overview' && (!data.totalJobs || !data.lastRun || data.lastRun.status==='running' || data.lastRun.status==='failed'))throw new Error('Snapshot has no active roles or no finished usable refresh.');
    console.log(JSON.stringify({path,total:data.totalJobs??data.total??data.length}));
  }
  const payModel=JSON.parse(await readFile('data/pay-model.json','utf8'));
  if(!isPayModel(payModel))throw new Error('Pay model is missing or has an unexpected shape.');
  if(!payModel.currencies.USD)console.warn('Pay model has no USD currency; estimate_pay will report that it cannot estimate USD.');
  console.log(JSON.stringify({payModel:Object.fromEntries(Object.entries(payModel.currencies).map(([c,m])=>[c,{roles:m.roles,features:Object.keys(m.weights).length}]))}));
  const write=await fetcher(new Request('https://atlas.test/api/refresh',{method:'POST'}));if(write.status!==405)throw new Error('Public API must be read-only.');
}finally{close();}
