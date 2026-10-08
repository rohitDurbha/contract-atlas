import { load } from 'cheerio/slim';
import type { Job } from '../src/types.js';
import type { SourceConfig } from './sources.js';
import type { Collection } from './adapters.js';
import { makeJob, safeUrl, workMode } from './normalize.js';
type Reader=(url:string)=>Promise<string>;
function finish(jobs:Job[],total:number,complete:boolean,label:string):Collection {
  const unique=[...new Map(jobs.map(j=>[j.id,j])).values()];
  complete=complete && unique.length===total && unique.length===jobs.length;
  return {jobs:unique,status:'healthy',complete,advertisedCount:total,retrievedCount:unique.length,
    message:`${label}: ${unique.length} of ${total} advertised roles retrieved, including all employment types. ${complete?'Every listing page verified.':'Coverage incomplete; previous listings retained.'}`};
}
export function parseInspyr(source:SourceConfig,html:string,now:string) {
  const $=load(html),jobs:Job[]=[];
  const raw=html.match(/window\.FWP_JSON\s*=\s*(\{[^\n]+\});/);
  const pager=raw?JSON.parse(raw[1]).preload_data?.settings?.pager:undefined;
  if(!pager || !Number.isInteger(pager.total_rows) || !Number.isInteger(pager.total_pages) || !Number.isInteger(pager.page))throw new Error('INSPYR public pagination metadata unavailable.');
  let cards=0;
  $('.pp-content-post[data-id]').each((_,el)=> {
    const card=$(el),a=card.find('a.home_jobs_title').first();if(!a.length)return;cards++;
    const info=card.find('.home_jobs_more_info').map((_,e)=>$(e).text().trim()).get();
    const job=makeJob(source,{sourceJobId:card.attr('data-id') || '',title:a.text(),applyUrl:safeUrl(a.attr('href'),source.url)||'',
      location:info[0],employmentType:info[1] || 'Not specified',category:info[2],workMode:workMode(info[0]),postedAt:card.find('meta[itemprop="datePublished"]').attr('content')},now);
    if(job)jobs.push(job);
  });
  return {jobs,cards,total:pager.total_rows as number,pages:pager.total_pages as number,page:pager.page as number};
}
export async function inspyrFeed(source:SourceConfig,html:string,now:string,read:Reader):Promise<Collection> {
  const first=parseInspyr(source,html,now),jobs=[...first.jobs];
  if(first.pages>150 || first.pages<0 || first.total<0 || first.page!==1)return finish(jobs,first.total,false,'INSPYR');
  let valid=first.cards===first.jobs.length;
  // Follow the same public page links as the board. The generic WP endpoint
  // includes posts outside this board and must not be used as its membership list.
  try {
    for(let start=2;start<=first.pages;start+=4) {
      const pages=await Promise.allSettled(Array.from({length:Math.min(4,first.pages-start+1)},async(_,i)=> {
        const number=start+i,url=new URL(source.url);url.searchParams.set('_paged',String(number));
        const page=parseInspyr(source,await read(url.href),now);
        return {number,page};
      }));
      for(const result of pages) {
        if(result.status==='rejected'){valid=false;continue;}
        const {number,page}=result.value;
        valid &&= page.page===number && page.total===first.total && page.pages===first.pages && page.cards===page.jobs.length;
        jobs.push(...page.jobs);
      }
      if(!valid)break;
    }
  } catch {valid=false;}
  return finish(jobs,first.total,valid,'INSPYR');
}
function envelope(text:string) {
  const value=JSON.parse(text),total=Number(value.headers?.['X-WP-Total']),pages=Number(value.headers?.['X-WP-TotalPages']);
  if(value.status!==200 || !Array.isArray(value.body) || !Number.isInteger(total) || total<0 || !Number.isInteger(pages) || pages<0 || pages>100)throw new Error('Public WordPress pagination response invalid.');
  return {rows:value.body as Record<string,any>[],total,pages};
}
export async function tundraFeed(source:SourceConfig,now:string,read:Reader):Promise<Collection> {
  const base=new URL('/wp-json/wp/v2/',source.url);
  const countries=envelope(await read(`${base}country?per_page=100&_fields=id,name&_envelope=1`));
  if(countries.pages>1 || countries.rows.length!==countries.total)throw new Error('Tundra country metadata incomplete.');
  const names=new Map(countries.rows.map(r=>[r.id,r.name]));
  const url=(page:number)=>`${base}matador-job-listings?per_page=100&page=${page}&_fields=id,date_gmt,link,title,content,meta._matador_source_id,country&_envelope=1`;
  let page=envelope(await read(url(1)));const total=page.total,pages=page.pages,jobs:Job[]=[];let valid=true;
  try {
    for(let n=1;n<=Math.max(1,pages);n++) {
      if(n>1)page=envelope(await read(url(n)));
      if(page.total!==total || page.pages!==pages){valid=false;break;}
      for(const row of page.rows) {
        const $=load(row.content?.rendered || ''),info=$('.job-info').first();
        const location=info.find('i.ph-map-pin').parent().find('span').text().trim();
        const type=info.find('i.ph-suitcase').parent().find('span').text().trim();
        const country=(row.country || []).map((id:number)=>names.get(id)).filter(Boolean).join(', ') || 'Not specified';
        $('.job-info,nav,script,style,form').remove();
        const job=makeJob(source,{sourceJobId:String(row.meta?._matador_source_id || row.id || ''),title:row.title?.rendered || '',applyUrl:row.link || '',
          description:$.html(),location,country,employmentType:type || 'Not specified',workMode:workMode(location),
          postedAt:row.date_gmt && !row.date_gmt.startsWith('0000')?row.date_gmt+'Z':null},now);
        if(job)jobs.push(job);else valid=false;
      }
    }
  } catch {valid=false;}
  return finish(jobs,total,valid,'Tundra');
}
