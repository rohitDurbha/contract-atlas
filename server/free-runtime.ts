import worker from './index.js';
const ctx={waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext;
export function freeFetch(db:D1Database) {
  return async(request:Request)=>{
    if(!['GET','HEAD'].includes(request.method))return Response.json({error:'The free public API is read-only. Collection runs on GitHub Actions.'},{status:405,headers:{Allow:'GET, HEAD'}});
    return worker.fetch(request,{DB:db},ctx);
  };
}
