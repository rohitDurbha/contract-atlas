import { afterEach,describe,it,expect,vi } from 'vitest';
import { collectSource,parseTalentNet } from '../server/adapters';
import { SOURCES } from '../server/sources';

const source=SOURCES.find(s=>s.id==='meta')!;
const now='2026-09-30T22:00:00.000Z';
// Fields captured from the public Meta feed for the role in the reported screenshot.
const role={id:'6718a88d-98ae-4af0-a8e9-b2b649e55858',title:{name:'Data Labeling Analyst V',isValid:true},type:'contract',status:'published',closedAt:null,description:'<p>Review data labels.</p>',location:{city:'Bell Gardens',code:'CA',country:'United States',countryCode:'US',address:'Remote Location, Remote Location, CA, 90201'},workplaceType:'on-site',publishedOrCreatedTime:'2026-09-30T16:42:42-04:00',durationText:'2 months 6 days',payRangeMin:null,payRangeMax:null,payRangeCurrency:'USD',skills:[{name:'Data labeling analyst'},{name:'DLA'}]};
const apiOrigin='https://talentnet-api-v6.v6-prod-use1.talentnet.community';
function feed(pages:any[][],total:number,status=200) {
  const requests:string[]=[];
  const mock=vi.fn(async(url:string,init?:RequestInit)=>{
    requests.push(url);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    const u=new URL(url);
    if(u.pathname==='/robots.txt')return new Response('User-agent: *\nDisallow: /jobs/search');
    if(u.pathname==='/')return new Response("<script>window.tenant='us.meta';window.env='prod';</script>");
    if(u.pathname==='/prod/us.meta.json')return Response.json({tenant:'facebook_us',endpoints:{api:apiOrigin}});
    expect(u.origin).toBe(apiOrigin);expect(u.pathname).toBe('/api/community/jobs/search');
    expect(new Headers(init?.headers).get('x-tenant')).toBe('facebook_us');
    const page=Number(u.searchParams.get('page'));
    return Response.json({data:pages[page-1]??[],meta:{pageCount:pages.length,totalCount:total}},{status});
  });
  vi.stubGlobal('fetch',mock);return requests;
}
afterEach(()=>vi.unstubAllGlobals());
describe('TalentNet public feed regression',()=>{
  it('normalizes the missing screenshot role with its real title, city, and source posting time',()=>{
    const [job]=parseTalentNet(source,[role],now);
    expect(job.title).toBe('Data Labeling Analyst V');
    expect(job.location).toBe('Bell Gardens, CA, United States');
    expect(job.country).toBe('US');expect(job.workMode).toBe('On-site');
    expect(job.postedAt).toBe('2026-09-30T20:42:42.000Z');
    expect(job.firstSeenAt).toBe(now);expect(job.payMin).toBeNull();
    expect(job.skills).toEqual(['Data labeling analyst','DLA']);
    expect(job.applyUrl).toBe('https://us.meta.talentnet.community/jobs/6718a88d-98ae-4af0-a8e9-b2b649e55858');
    expect(parseTalentNet(source,[{...role,status:'closed'},{...role,type:'permanent'}],now)).toEqual([]);
  });
  it('retrieves all capped pages from the public feed without crawling the excluded search page',async()=>{
    const rows=Array.from({length:5},(_,i)=>({...role,id:`role-${i}`}));
    const requests=feed([rows.slice(0,2),rows.slice(2,4),rows.slice(4)],5);
    const result=await collectSource(source,now);
    expect(result.status).toBe('healthy');expect(result.complete).toBe(true);
    expect(result.jobs).toHaveLength(5);expect(result.advertisedCount).toBe(5);
    expect(requests.filter(x=>new URL(x).pathname==='/api/community/jobs/search')).toHaveLength(3);
    expect(requests).not.toContain(source.url);
  });
  it('records a real access denial without retrying through authentication',async()=>{
    const requests=feed([[]],0,401);const result=await collectSource(source,now);
    expect(result.status).toBe('blocked');expect(result.complete).toBe(false);
    expect(requests.filter(x=>new URL(x).pathname==='/api/community/jobs/search')).toHaveLength(1);
  });
  it('does not claim full coverage when advertised listings are missing or malformed',async()=>{
    feed([[role]],3);expect((await collectSource(source,now)).complete).toBe(false);
    feed([[{...role,title:{}}]],1);const malformed=await collectSource(source,now);
    expect(malformed.jobs).toHaveLength(0);expect(malformed.complete).toBe(false);
  });
  it('detects repeated pagination instead of declaring a duplicate-filled feed complete',async()=>{
    feed([[role],[role]],2);const result=await collectSource(source,now);
    expect(result.status).toBe('error');expect(result.complete).toBe(false);
    expect(result.message).toContain('repeated a page');
  });
});
