import { resolve } from 'node:path';
import { openSQLite } from '../server/sqlite.js';
import { freeFetch } from '../server/free-runtime.js';
import { createAtlasMcpHandler } from '../server/mcp.js';
const {db}=openSQLite(resolve(process.cwd(),'data/atlas.sqlite'),true);
const fetcher=freeFetch(db);
const mcp=createAtlasMcpHandler(db);
export default {fetch(request:Request) {
  const url=new URL(request.url),route=url.searchParams.get('__atlasRoute');
  if(route!==null) {url.pathname='/api/'+route;url.searchParams.delete('__atlasRoute');request=new Request(url,request);}
  // The MCP endpoint speaks JSON-RPC over POST, so it is routed before the read-only REST guard.
  if(url.pathname==='/api/mcp')return mcp.fetch(request);
  return fetcher(request);
}};
