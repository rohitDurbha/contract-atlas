import { createServer } from 'node:http';
import api from '../api/index';

createServer(async(req,res)=>{
  try {
    const response=await api.fetch(new Request(new URL(req.url||'/', 'http://127.0.0.1:8787'),{method:req.method}));
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch {
    res.writeHead(500,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'Local API failed.'}));
  }
}).listen(8787,'127.0.0.1',()=>console.log('Read-only snapshot API: http://127.0.0.1:8787'));
