const base=process.argv[2];
if(!base)throw new Error('Pass the published origin.');
const headers=process.env.ATLAS_SITE_TOKEN?{'OAI-Sites-Authorization':`Bearer ${process.env.ATLAS_SITE_TOKEN}`} : {};
for(const path of ['/', '/api/health','/api/overview','/api/jobs?mode=Remote&category=Data%20%26%20Analytics','/api/sources']) {
  const r=await fetch(new URL(path,base),{headers});
  const body=await r.text();
  let result;
  try {const d=JSON.parse(body);result=Array.isArray(d)?{sourceCount:d.length,healthy:d.filter(s=>s.status==='healthy').length}:d.jobs?{total:d.total,returned:d.jobs.length,first:d.jobs[0]?.title}:d;}catch{result=body.slice(0,180);}
  console.log(JSON.stringify({path,status:r.status,result}));
}
