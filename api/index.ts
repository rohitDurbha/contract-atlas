import { resolve } from 'node:path';
import { openSQLite } from '../server/sqlite';
import { freeFetch } from '../server/free-runtime';
const {db}=openSQLite(resolve(process.cwd(),'data/atlas.sqlite'),true);
const fetcher=freeFetch(db);
export default {fetch(request:Request) {
  const url=new URL(request.url),route=url.searchParams.get('__atlasRoute');
  if(route!==null) {url.pathname='/api/'+route;url.searchParams.delete('__atlasRoute');request=new Request(url,request);}
  return fetcher(request);
}};
