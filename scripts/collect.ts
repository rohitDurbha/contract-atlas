import { writeFile, readFile } from 'node:fs/promises';
import { collectSource } from '../server/adapters';
import { SOURCES } from '../server/sources';
import type { Job } from '../src/types';
const selected=process.argv.slice(2);
const previous=selected.length?JSON.parse(await readFile('server/seed.json','utf8')):{jobs:[],sources:[]};
const now=new Date().toISOString(),jobs:Job[]=previous.jobs.filter((j:Job)=>!selected.includes(j.sourceId)),sources:any[]=previous.sources.filter((s:any)=>!selected.includes(s.id));
const queue=SOURCES.filter(s=>!selected.length || selected.includes(s.id));
let cursor=0;
await Promise.all(Array.from({length:4},async()=> {
  while(cursor<queue.length) {
    const s=queue[cursor++];
    const result=await collectSource(s,now);
    jobs.push(...result.jobs);
    sources.push({id:s.id,status:result.status,message:result.message,complete:result.complete,advertisedCount:result.advertisedCount,jobCount:result.jobs.length});
    console.log(`${s.company}: ${result.status} · ${result.jobs.length} roles · ${result.message}`);
  }
}));
const unique=[...new Map(jobs.map(j=>[j.id,j])).values()];
await writeFile('server/seed.json',JSON.stringify({collectedAt:now,jobs:unique,sources},null,2)+'\n');
console.log(`Indexed ${unique.length} real roles; ${sources.filter(s=>s.status==='healthy').length}/${SOURCES.length} sources readable. Refreshed ${queue.length} sources.`);
