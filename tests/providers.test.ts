import { describe, expect, it } from 'vitest';
import { magnitFeed, opptlyFeed, parseMagnitPage } from '../server/public-feeds';
import type { SourceConfig } from '../server/sources';
const now='2026-10-08T21:00:00.000Z';
const base:SourceConfig={id:'test',company:'Test',provider:'Magnit',country:'US',url:'https://example.willhire.co/jobs',contractOnly:true};
const card=(id:number)=>`<div class="job-card"><a class="job-title" id="mix_title_${id}" href="/jobs/${id}-analyst">Analyst ${id}</a><span class="info-text">Boston (Hybrid)</span><span class="info-text">Posted: Today</span></div>`;
const board=(total:number,ids:number[])=>`<div class="count-label">Found <span>${total}</span> Jobs</div>${ids.map(card).join('')}`;
describe('complete public provider feeds',()=> {
  it('Magnit reads all pages at the requested size, preserves stable IDs and leaves relative dates unknown',async()=> {
    const requests:string[]=[];
    const r=await magnitFeed(base,board(101,[1]),now,async url=>{requests.push(url);const page=new URL(url).searchParams.get('page');return page==='1'?board(101,Array.from({length:100},(_,i)=>i+1)):board(101,[101]);});
    expect(r.complete).toBe(true);expect(r.jobs).toHaveLength(101);
    expect(requests.map(u=>new URL(u).searchParams.get('page'))).toEqual(['1','2']);
    expect(r.jobs[0]).toMatchObject({id:'test:1',postedAt:null,workMode:'Hybrid'});
  });
  it('Magnit verifies empty boards but fails closed for repeated or changed pages',async()=> {
    expect((await magnitFeed(base,board(0,[]),now,async()=>{throw Error('unexpected request');})).complete).toBe(true);
    expect((await magnitFeed(base,board(101,[1]),now,async()=>board(101,[1]))).complete).toBe(false);
    expect(parseMagnitPage(base,'<div>No jobs</div>',now).advertisedCount).toBeUndefined();
  });
  it('Opptly exhausts the linked public portal and does not copy another tenant or closed roles',async()=> {
    const source={...base,provider:'Raise' as const,url:'https://example.raise.jobs/'};
    const requests:string[]=[];
    const r=await opptlyFeed(source,'<iframe src="https://apply-example.opptly.ai/"></iframe>',now,async url=>{requests.push(url);return JSON.stringify(url.endsWith('page=1')?[{id:1,title:'Analyst',status:{statusName:'Open'},postedDate:'2026-10-06',location_type:'Remote'},{id:2,title:'Closed',status:{statusName:'Closed'}}]:[]);},async()=>{});
    expect(r.complete).toBe(true);expect(requests).toHaveLength(2);expect(requests[0]).toContain('/example?page=1');
    expect(r.jobs).toHaveLength(1);expect(r.jobs[0].applyUrl).toBe('https://apply-example.opptly.ai/job?id=1');
  });
  it('Opptly repeated pages and mid-run failures retain data without claiming full coverage',async()=> {
    const source={...base,provider:'Raise' as const};const html='<iframe src="https://apply-example.opptly.ai/"></iframe>';
    const r=await opptlyFeed(source,html,now,async()=>JSON.stringify([{id:1,title:'Analyst',status:{statusName:'Open'}}]),async()=>{});
    expect(r.complete).toBe(false);expect(r.jobs).toHaveLength(1);
  });
});
