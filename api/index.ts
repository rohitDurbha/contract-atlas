import { resolve } from 'node:path';
import { openSQLite } from '../server/sqlite.js';
import { freeFetch } from '../server/free-runtime.js';
import { readFileSync } from 'node:fs';
import { createAtlasMcpHandler } from '../server/mcp.js';
import { isPayModel, type PayModel } from '../server/pay-model.js';
import { createQueryEmbedder } from '../server/semantic-feed.js';
import { BUNDLED_MODEL_DIR, loadFastEmbedder } from '../server/fastembed.js';
const {db}=openSQLite(resolve(process.cwd(),'data/atlas.sqlite'),true);
// The query model loads on the first semantic search, from the copy the
// refresh workflow bundles beside the snapshot.
const embedder=createQueryEmbedder(()=>loadFastEmbedder({cacheDir:resolve(process.cwd(),BUNDLED_MODEL_DIR),offline:true}));
const fetcher=freeFetch(db,embedder);
// The pay model is trained by the refresh workflow and bundled beside the
// snapshot. A missing or malformed file only disables estimate_pay.
function loadPayModel():PayModel|null {
  try {const model=JSON.parse(readFileSync(resolve(process.cwd(),'data/pay-model.json'),'utf8'));return isPayModel(model)?model:null;}
  catch {return null;}
}
const payModel=loadPayModel();
const mcp=createAtlasMcpHandler(db,{payModel:()=>payModel,embedder});
export default {fetch(request:Request) {
  const url=new URL(request.url),route=url.searchParams.get('__atlasRoute');
  if(route!==null) {url.pathname='/api/'+route;url.searchParams.delete('__atlasRoute');request=new Request(url,request);}
  // The MCP endpoint speaks JSON-RPC over POST, so it is routed before the read-only REST guard.
  if(url.pathname==='/api/mcp')return mcp.fetch(request);
  return fetcher(request);
}};
