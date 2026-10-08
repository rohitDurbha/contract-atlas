import { describe,it,expect } from 'vitest';
import { robotsAllowed,parseJSONLD,parseHireHQ } from '../server/adapters';
import { SOURCES } from '../server/sources';
import { date,money,safeUrl,deriveSkills } from '../server/normalize';
const source=SOURCES.find(s=>s.id==='jnj')!;
const now='2026-09-30T20:00:00.000Z';
describe('source normalization',()=> {
  it('keeps real posting dates separate from discovery and rejects permanent roles',()=> {
    const html='<script type="application/ld+json">'+JSON.stringify({'@graph':[
      {'@type':'JobPosting',title:'Data Analyst',employmentType:'CONTRACTOR',url:'https://jnj.toptalents.com/jobs/12345',datePosted:'2026-09-24',description:'Use SQL and Python.'},
      {'@type':'JobPosting',title:'Permanent Analyst',employmentType:'FULL_TIME',url:'https://jnj.toptalents.com/jobs/99999'},
    ]})+'</script>';
    const jobs=parseJSONLD(source,html,now);
    expect(jobs).toHaveLength(1);expect(jobs[0].postedAt).toBe('2026-09-24T00:00:00.000Z');expect(jobs[0].firstSeenAt).toBe(now);expect(jobs[0].skills).toEqual(['Python','SQL']);
  });
  it('ignores expired listings and unsafe application URLs',()=> {
    const html='<script type="application/ld+json">'+JSON.stringify([
      {'@type':'JobPosting',title:'Expired',employmentType:'TEMPORARY',url:'https://jnj.toptalents.com/jobs/12345',validThrough:'2026-09-01'},
      {'@type':'JobPosting',title:'Bad URL',employmentType:'CONTRACT',url:'javascript:alert(1)'},
    ])+'</script>';
    expect(parseJSONLD(source,html,now)).toEqual([]);
  });
  it('honors pay visibility and filters noncontract hireHQ jobs',()=> {
    const meta={job_job_type:[{code:3,status:'Contingent/Contract'},{code:1,status:'Full Time'}],job_currency:[{code:1,status:'USD'}],job_work_from:[{code:3,status:'Hybrid'}],job_payment_term:[{code:1,status:'Per hour'}]};
    const rows=[{job_id:'a',job_title:'Analyst',job_type:3,status:1,work_from:3,pay_rate_visibility:false,budget_minimum_per_payment_term:50,currency:1,payment_term:1},{job_id:'b',job_title:'Permanent',job_type:1,status:1}];
    const jobs=parseHireHQ(source,rows,now,meta);expect(jobs).toHaveLength(1);expect(jobs[0].payMin).toBeNull();expect(jobs[0].currency).toBeNull();expect(jobs[0].workMode).toBe('Hybrid');
  });
  it('does not turn missing compensation into a zero-dollar offer',()=>{expect(money(null)).toBeNull();expect(money('0')).toBeNull();expect(money('72.50')).toBe(72.5);expect(date('not a date')).toBeNull();expect(safeUrl('http://example.com','https://example.com')).toBeNull();});
});
describe('collection boundaries',()=> {
  it('registers all 61 portals once',()=>{expect(SOURCES).toHaveLength(61);expect(new Set(SOURCES.map(s=>s.id)).size).toBe(61);expect(SOURCES.every(s=>s.url.startsWith('https://'))).toBe(true);});
  it('uses the longest robots rule, allowing exceptions and specific agents',()=> {
    const robots='User-agent: *\nDisallow: /jobs\nAllow: /jobs/public\n\nUser-agent: ContractAtlas\nDisallow: /private';
    expect(robotsAllowed(robots,'/jobs')).toBe(true);
    expect(robotsAllowed(robots,'/private/jobs')).toBe(false);
    expect(robotsAllowed('User-agent: *\nDisallow: /jobs\nAllow: /jobs/public','/jobs/123')).toBe(false);
    expect(robotsAllowed('User-agent: *\nDisallow: /jobs\nAllow: /jobs/public','/jobs/public/123')).toBe(true);
  });
});
