const base=process.argv[2];
if(!base)throw new Error('Pass the published origin.');
const headers=process.env.ATLAS_ADMIN_TOKEN?{Authorization:`Bearer ${process.env.ATLAS_ADMIN_TOKEN}`} : process.env.ATLAS_SITE_TOKEN?{'OAI-Sites-Authorization':`Bearer ${process.env.ATLAS_SITE_TOKEN}`} : {};
async function request(path,body){
  for(let attempt=0;attempt<3;attempt++) {
    const r=await fetch(new URL(path,base),{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60_000)});
    if([500,502,503,504].includes(r.status)&&attempt<2) {console.log('Retrying transient service error',r.status);await new Promise(resolve=>setTimeout(resolve,2000));continue;}
    const d=await r.json().catch(()=>{throw new Error(`The service returned HTTP ${r.status}. The persisted run can be resumed.`);});if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;
  }
}
if(process.argv.includes('--enable-schedule'))console.log('Schedule display',await request('/api/settings/schedule',{enabled:true}));
let run=await request('/api/refresh');console.log('Started',run.id,run.status);
while(run.status==='running') {const processed=run.processed;run=await request(`/api/refresh/${run.id}/step`);console.log(JSON.stringify(run));if(run.status==='running'&&run.processed===processed)await new Promise(resolve=>setTimeout(resolve,1000));}
console.log('Finished',run.status,run.newCount,'new roles;',run.successCount,'of',run.sourceCount,'sources connected.');
