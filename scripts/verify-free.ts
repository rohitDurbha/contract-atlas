import { SOURCES } from '../server/sources';
import { resolve } from 'node:path';
import { openSQLite } from '../server/sqlite';
import { freeFetch } from '../server/free-runtime';
const {db,close}=openSQLite(resolve('data/atlas.sqlite'),true);
try {
  const integrity=await db.prepare('PRAGMA quick_check').first<string>('quick_check');
  if(integrity!=='ok')throw new Error('Snapshot integrity check failed; publishing stopped.');
  const invalid=await db.prepare("SELECT count(*) n FROM jobs WHERE NOT json_valid(data) OR trim(title)='' OR apply_url NOT LIKE 'https://%'").first<any>();
  if(invalid.n)throw new Error('Snapshot contains malformed job records; publishing stopped.');
  const fetcher=freeFetch(db);
  for(const path of ['/api/overview','/api/sources','/api/jobs?q=Data%20Labeling%20Analyst','/api/jobs?page=2','/api/jobs?sort=pay']) {
    const response=await fetcher(new Request('https://atlas.test'+path));if(response.status!==200)throw new Error(`Snapshot verification failed: ${path}`);
    const data=await response.json() as any;
    if(path==='/api/sources'&&data.length!==SOURCES.length)throw new Error('Source registry incomplete.');
    if(path==='/api/overview' && (!data.totalJobs || !data.lastRun || data.lastRun.status==='running' || data.lastRun.status==='failed'))throw new Error('Snapshot has no active roles or no finished usable refresh.');
    console.log(JSON.stringify({path,total:data.totalJobs??data.total??data.length}));
  }
  const write=await fetcher(new Request('https://atlas.test/api/refresh',{method:'POST'}));if(write.status!==405)throw new Error('Public API must be read-only.');
}finally{close();}
