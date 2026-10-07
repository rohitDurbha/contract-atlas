import worker from './index';
const ctx={waitUntil(){},passThroughOnException(){},props:{}} as unknown as ExecutionContext;
export function freeFetch(db:D1Database) {
  return async(request:Request)=>{
    const path=new URL(request.url).pathname;
    if(!['GET','HEAD'].includes(request.method))return Response.json({error:'The free public API is read-only. Collection runs on GitHub Actions.'},{status:405,headers:{Allow:'GET, HEAD'}});
    if(path==='/api/access')return Response.json({canRefresh:false},{headers:{'Cache-Control':'no-store'}});
    return worker.fetch(request,{DB:db,ASSETS:{fetch:async()=>new Response('Not found',{status:404})} as unknown as Fetcher},ctx);
  };
}
