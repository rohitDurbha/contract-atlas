import worker from './index.js';
import type { Database } from './database.js';
import type { QueryEmbedder } from './semantic-feed.js';
export function freeFetch(db:Database,embedder?:QueryEmbedder|null) {
  return async(request:Request)=>{
    if(!['GET','HEAD'].includes(request.method))return Response.json({error:'The free public API is read-only. Collection runs on GitHub Actions.'},{status:405,headers:{Allow:'GET, HEAD'}});
    return worker.fetch(request,{DB:db,EMBED:embedder});
  };
}
