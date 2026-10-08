import { describe, expect, it } from 'vitest';
import { magnitFeed, randstadFeed, opptlyFeed, parseMagnitPage, parseRandstad } from '../server/public-feeds';
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
  it('Randstad follows offsets even when the provider caps page size and excludes closed records',async()=> {
    const source={...base,provider:'Randstad' as const,url:'https://example.talent-community.com/'};
    const offsets:number[]=[];
    const row=(id:number)=>({id,title:'Contract analyst',status:'ACTIVE',jobPublicUrl:`https://example.talent-community.com/projects/analyst/${id}`,publishDate:'2026-10-07T12:00:00Z'});
    const r=await randstadFeed(source,'<a href="/projects">Jobs</a>',now,async(url,headers,body:any)=>{expect(url).toContain('/publicsearch/');expect(body.query).toBe('status = ACTIVE');offsets.push(body.offset);return JSON.stringify({totalResults:3,results:body.offset===0?[row(1),row(2)]:[row(3)]});},async()=>{});
    expect(offsets).toEqual([0,2]);expect(r.complete).toBe(true);expect(r.jobs).toHaveLength(3);
    expect(parseRandstad(source,[{...row(4),status:'CLOSED'}],now)).toEqual([]);
  });
  it('Randstad refuses repeated pages and cannot mark incomplete totals complete',async()=> {
    const source={...base,provider:'Randstad' as const,url:'https://example.talent-community.com/'};
    const row={id:1,title:'Analyst',status:'ACTIVE',jobPublicUrl:'https://example.talent-community.com/projects/analyst/1'};
    const r=await randstadFeed(source,'<a href="/projects">Jobs</a>',now,async()=>JSON.stringify({totalResults:3,results:[row]}),async()=>{});
    expect(r.complete).toBe(false);expect(r.jobs).toHaveLength(1);
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
