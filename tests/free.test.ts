import { mkdtemp,readFile,rm,copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect,vi } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB } from '../server/db';
import { freeFetch } from '../server/free-runtime';
vi.mock('../server/adapters',()=>({collectSource:vi.fn(async(source:any)=>({jobs:[],status:source.id==='meta'?'blocked':'healthy',message:'Test collection result',complete:false}))}));
import { runScheduled } from '../server/ingestion';
import publicAPI from '../api/index';

describe('free standalone snapshot',()=>{
  it('preserves search parameters when Vercel rewrites API paths',async()=>{
    const result=await publicAPI.fetch(new Request('https://atlas.test/api/index?__atlasRoute=jobs&q=Data%20Labeling%20Analyst'));
    expect(result.status).toBe(200);
    expect((await result.json() as any).total).toBeGreaterThan(0);
    expect((await publicAPI.fetch(new Request('https://atlas.test/api/index?__atlasRoute=sources'))).status).toBe(200);
    expect((await publicAPI.fetch(new Request('https://atlas.test/api/index?__atlasRoute=refresh',{method:'POST'}))).status).toBe(405);
  });
  it('serves the persisted feed with public read-only search and preserves the database bytes',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'atlas-free-')),path=join(dir,'atlas.sqlite');
    try {
      await copyFile('data/atlas.sqlite',path);
      const before=await readFile(path),reader=openSQLite(path,true),fetcher=freeFetch(reader.db);
      try {
        for(const route of ['/api/overview','/api/sources','/api/jobs?q=Data%20Labeling%20Analyst','/api/jobs?page=2','/api/jobs?sort=pay','/api/runs'])expect((await fetcher(new Request('https://atlas.test'+route))).status).toBe(200);
        const sources=await (await fetcher(new Request('https://atlas.test/api/sources'))).json() as any[];expect(sources.length).toBe(61);
        const roles=await (await fetcher(new Request('https://atlas.test/api/jobs?q=Data%20Labeling%20Analyst'))).json() as any;expect(roles.total).toBeGreaterThan(0);
        const access=await (await fetcher(new Request('https://atlas.test/api/access'))).json();expect(access).toEqual({canRefresh:false});
        expect((await fetcher(new Request('https://atlas.test/api/refresh',{method:'POST'}))).status).toBe(405);
      }finally{reader.close();}
      expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('records source failures without removing previous roles or resetting last-success history',async()=>{
    const {db,close}=openSQLite(':memory:');
    try {
      await ensureDB(db);
      const before=await db.prepare("SELECT last_success_at FROM sources WHERE id='meta'").first<any>();
      const count=await db.prepare("SELECT count(*) AS n FROM jobs WHERE source_id='meta' AND active=1").first<any>();
      const run=await runScheduled(db);expect(run.status).toBe('partial');expect(run.sourceCount).toBe(61);expect(run.successCount).toBe(60);
      const after=await db.prepare("SELECT status,last_success_at FROM sources WHERE id='meta'").first<any>();
      expect(after.status).toBe('blocked');expect(after.last_success_at).toBe(before.last_success_at);
      expect((await db.prepare("SELECT count(*) AS n FROM jobs WHERE source_id='meta' AND active=1").first<any>()).n).toBe(count.n);
    }finally{close();}
  });
});
