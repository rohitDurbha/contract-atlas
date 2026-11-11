import { load } from 'cheerio/slim';
import type { Job } from '../src/types.js';
import type { SourceConfig } from './sources.js';
import type { Collection } from './adapters.js';
import { date, makeJob, money, safeUrl, workMode } from './normalize.js';

type Row = Record<string, any>;
type Reader = (url:string, headers?:Record<string,string>)=>Promise<string>;
type Robots = (source:SourceConfig)=>Promise<void>;
const unique = (jobs:Job[])=>[...new Map(jobs.map(j=>[j.id,j])).values()];
function result(jobs:Job[],complete:boolean,label:string,advertisedCount?:number,retrievedCount?:number):Collection {
  jobs=unique(jobs);
  return {jobs,complete,status:'healthy',advertisedCount,retrievedCount,message:`${label}: collected ${jobs.length} active contract roles${advertisedCount===undefined?'':`; ${advertisedCount} records advertised`}. ${complete?'All listing pages verified.':'Full coverage could not be verified; previous listings retained.'}`};
}

// Magnit/WillHire renders listing cards with a count, including cards whose
// detail pages lack JobPosting metadata. Use the board's own page/size controls.
export function parseMagnitPage(source:SourceConfig,html:string,now:string) {
  const $=load(html),jobs:Job[]=[];
  const countText=$('.count-label').text().replace(/\s+/g,' ');
  const count=countText.match(/Found\s+([\d,]+)\s+(?:Jobs|Assignments)/i);
  const advertisedCount=count?Number(count[1].replace(/,/g,'')):undefined;
  let malformed=0,cards=0;
  $('.job-card').each((_,el)=> {
    const card=$(el),a=card.find('a.job-title').first();
    if(!a.length)return;
    cards++;
    const href=safeUrl(a.attr('href'),source.url),id=a.attr('id')?.match(/mix_title_(\d+)/)?.[1] || href?.match(/\/jobs\/(\d+)/)?.[1];
    const info=card.find('span.info-text').map((_,s)=>$(s).text().replace(/\s+/g,' ').trim()).get();
    const location=info.find(s=>/\((?:remote|hybrid|on.?site)\)/i.test(s)) || info.find(s=>!/^Posted:/i.test(s)&&!/(?:week|month|day|year)\(s\)/i.test(s));
    const posted=info.find(s=>/^Posted:/i.test(s))?.replace(/^Posted:\s*/i,'');
    // Relative labels do not provide an exact timestamp. Leave them unknown.
    const postedAt=posted && !/today|yesterday|ago/i.test(posted)?date(posted):null;
    const job=makeJob(source,{sourceJobId:id || '',title:a.text(),applyUrl:href || '',location,
      workMode:workMode(location),postedAt,category:card.find('small.info-text').first().text(),
      duration:info.find(s=>/(?:week|month|day|year)\(s\)/i.test(s)),
      skills:card.find('.common-skill-chip').map((_,s)=>$(s).text().trim()).get(),
    },now);
    if(job)jobs.push(job);else malformed++;
  });
  return {jobs,advertisedCount,cards,malformed};
}
export async function magnitFeed(source:SourceConfig,html:string,now:string,read:Reader):Promise<Collection> {
  if(source.id==='applemarcom' && /applecontingentworkforce\.willhire\.co/.test(html) && !/applemarcom\.willhire\.co\/jobs\//.test(html)) {
    return {jobs:[],complete:false,status:'needs_adapter',retireExisting:true,message:'Apple Marcom redirects to the Apple contingent board. A separate public Marcom feed is not available at this registered URL.'};
  }
  let page=parseMagnitPage(source,html,now);
  if(page.advertisedCount===undefined) return {jobs:[],complete:false,status:'needs_adapter',message:'Magnit listing count or cards were not found; the board may have moved. Existing listings retained.'};
  const total=page.advertisedCount;
  let jobs:Job[]=[],seen=new Set<string>(),malformed=0;
  const maxPages=Math.max(1,Math.ceil(total/100));
  if(maxPages>100)return result(page.jobs,false,'Magnit public board',total);
  try {
    for(let number=1;number<=maxPages;number++) {
      if(total>page.cards || number>1) {
        const u=new URL(source.url);u.searchParams.set('page',String(number));u.searchParams.set('size','100');
        page=parseMagnitPage(source,await read(u.href),now);
      }
      if(page.advertisedCount!==total || (number>1 && page.jobs.some(j=>seen.has(j.id))))return result([...jobs,...page.jobs],false,'Magnit public board',total);
      malformed+=page.malformed;
      page.jobs.forEach(j=>seen.add(j.id));jobs.push(...page.jobs);
      if(seen.size>=total)break;
    }
  } catch(error) {
    if(!jobs.length)throw error;
    return result(jobs,false,'Magnit public board',total);
  }
  return result(jobs,malformed===0 && seen.size===total,'Magnit public board',total);
}

export function parseOpptly(source:SourceConfig,rows:Row[],portal:string,now:string):Job[] {
  return rows.filter(r=>r.status?.statusName==='Open').map(r=> {
    const locations=r.publish_locations_list || r.publish_locations || [],loc=locations[0] || {};
    return makeJob(source,{sourceJobId:String(r.id || ''),title:r.title,applyUrl:`${portal}/job?id=${encodeURIComponent(r.id)}`,
      description:r.description,location:locations.map((l:Row)=>[l.city,l.state || l.countrySubdivisionName,l.countryName || l.countryCode || l.country].filter(Boolean).join(', ')).join('; '),
      country:loc.countryCode || loc.country,workMode:workMode(r.location_type || loc.type),postedAt:r.postedDate,
      skills:r.skills,duration:r.contractEndDate?`Ends ${r.contractEndDate}`:null,
      payMin:money(loc.minRate),payMax:money(loc.maxRate),currency:loc.currencyCode,payPeriod:loc.rateFrequency?.toLowerCase(),
    },now);
  }).filter((j):j is Job=>!!j);
}
export async function opptlyFeed(source:SourceConfig,html:string,now:string,read:Reader,robots:Robots):Promise<Collection> {
  const $=load(html),iframe=$('iframe[src]').map((_,el)=>$(el).attr('src')).get().find(u=> {
    try{return new URL(u).hostname.endsWith('.opptly.ai');}catch{return false;}
  });
  if(!iframe)return {jobs:[],complete:false,status:'needs_adapter',message:'No public Opptly job portal is linked by this source.'};
  const portal=new URL(iframe),name=portal.hostname.split('.')[0].replace(/^apply-/,'');
  if(!/^[a-z0-9-]+$/.test(name))throw new Error('Invalid public Opptly portal name.');
  await robots({...source,url:portal.href});
  let jobs:Job[]=[],seen=new Set<string>(),malformed=false;
  try {
    for(let page=1;page<=100;page++) {
      const rows=JSON.parse(await read(`https://76pi7xyxb9.execute-api.us-east-2.amazonaws.com/api/job/getByPortalName/${name}?page=${page}`));
      if(!Array.isArray(rows))throw new Error('Unexpected Opptly public listing response.');
      if(!rows.length)return result(jobs,!malformed,'Opptly public API');
      if(rows.some(r=>!r.id || seen.has(String(r.id))))return result(jobs,false,'Opptly public API');
      rows.forEach(r=>seen.add(String(r.id)));
      const parsed=parseOpptly(source,rows,portal.origin,now);
      malformed ||= parsed.length!==rows.filter(r=>r.status?.statusName==='Open').length;
      jobs.push(...parsed);
    }
  } catch(error) {if(!jobs.length)throw error;}
  return result(jobs,false,'Opptly public API');
}
