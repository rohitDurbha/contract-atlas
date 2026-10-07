import { resolve } from 'node:path';
import { openSQLite } from '../server/sqlite';
import { freeFetch } from '../server/free-runtime';
const {db,close}=openSQLite(resolve('data/atlas.sqlite'),true);
try {
  const fetcher=freeFetch(db);
  for(const path of ['/api/overview','/api/sources','/api/jobs?q=Data%20Labeling%20Analyst']) {
    const response=await fetcher(new Request('https://atlas.test'+path));if(response.status!==200)throw new Error(`Snapshot verification failed: ${path}`);
    const data=await response.json() as any;
    if(path==='/api/sources'&&data.length!==59)throw new Error('Source registry incomplete.');
    console.log(JSON.stringify({path,total:data.totalJobs??data.total??data.length}));
  }
  const write=await fetcher(new Request('https://atlas.test/api/refresh',{method:'POST'}));if(write.status!==405)throw new Error('Public API must be read-only.');
}finally{close();}
