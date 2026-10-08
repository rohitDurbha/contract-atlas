import {describe,it,expect} from 'vitest';
import {inspyrFeed,tundraFeed} from '../server/staffing-feeds';
import {SOURCES} from '../server/sources';
const now='2026-10-08T23:00:00Z',inspyr=SOURCES.find(s=>s.id==='inspyr')!,tundra=SOURCES.find(s=>s.id==='tundra')!;
const card=(id:number,type='Direct Placement')=>`<article class="pp-content-post" data-id="${id}"><a class="home_jobs_title" href="/job/${id}">Developer</a><p class="home_jobs_more_info">Houston, TX</p><p class="home_jobs_more_info">${type}</p><meta itemprop="datePublished" content="2026-10-07T19:00:00+00:00"></article>`;
const page=(n:number,ids:number[],total=3)=>`<script>window.FWP_JSON = ${JSON.stringify({preload_data:{settings:{pager:{page:n,total_rows:total,total_pages:2}}}})};</script>${ids.map(i=>card(i)).join('')}`;
const env=(body:any[],total=body.length,pages=1)=>JSON.stringify({body,status:200,headers:{'X-WP-Total':total,'X-WP-TotalPages':pages}});
const row=(id:number)=>({id,meta:{_matador_source_id:String(id)},title:{rendered:'IT &#8211; Developer'},link:`https://community.tundratechnical.ca/jobs/${id}/`,date_gmt:'2026-10-08T20:28:13',country:[504],content:{rendered:'<div class="job-info"><div><i class="ph-map-pin"></i><span>Toronto, Ontario</span></div><div><i class="ph-suitcase"></i><span>Permanent</span></div></div><p>Python developer required</p>'}});
describe('staffing board completeness',()=>{
 it('follows INSPYR pages and keeps permanent labels and source dates',async()=>{
  const r=await inspyrFeed(inspyr,page(1,[1,2]),now,async url=>{expect(new URL(url).searchParams.get('_paged')).toBe('2');return page(2,[3]);});
  expect(r.complete).toBe(true);expect(r.jobs).toHaveLength(3);expect(r.jobs[0].employmentType).toBe('Direct Placement');expect(r.jobs[0].postedAt).toBe('2026-10-07T19:00:00.000Z');
 });
 it('does not mark duplicate, changed, or missing pages complete',async()=>{
  for(const next of [page(2,[1]),page(2,[3],4),page(1,[3])])expect((await inspyrFeed(inspyr,page(1,[1,2]),now,async()=>next)).complete).toBe(false);
  const r=await inspyrFeed(inspyr,page(1,[1,2]),now,async()=>{throw Error('timeout');});expect(r.complete).toBe(false);expect(r.jobs).toHaveLength(2);
 });
 it('walks WordPress headers and preserves country, type and UTC publication date',async()=>{
  const r=await tundraFeed(tundra,now,async url=>url.includes('/country?')?env([{id:504,name:'Canada'}]):env([row(new URL(url).searchParams.get('page')==='1'?1:2)],2,2));
  expect(r.complete).toBe(true);expect(r.jobs).toHaveLength(2);expect(r.jobs[0]).toMatchObject({employmentType:'Permanent',country:'Canada',title:'IT – Developer',postedAt:'2026-10-08T20:28:13.000Z'});
 });
 it('retains partial data when a later Tundra page fails; rejects repeated pages',async()=>{
  let r=await tundraFeed(tundra,now,async url=>{if(url.includes('/country?'))return env([]);if(url.includes('page=2&'))throw Error('503');return env([row(1)],2,2);});expect(r.complete).toBe(false);expect(r.jobs).toHaveLength(1);
  r=await tundraFeed(tundra,now,async url=>url.includes('/country?')?env([]):env([row(1)],2,2));expect(r.complete).toBe(false);
 });
});
