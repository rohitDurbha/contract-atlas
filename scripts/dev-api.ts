import { createServer } from 'node:http';
import api from '../api/index';

createServer(async(req,res)=>{
  try {
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
    const hasBody=!['GET','HEAD'].includes(req.method||'GET')&&chunks.length>0;
    const response=await api.fetch(new Request(new URL(req.url||'/', 'http://127.0.0.1:8787'),{method:req.method,headers,body:hasBody?Buffer.concat(chunks):undefined}));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch {
    res.writeHead(500,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Local API failed.'}));
  }
}).listen(8787,'127.0.0.1',()=>console.log('Read-only snapshot API: http://127.0.0.1:8787 (MCP at /api/mcp)'));
