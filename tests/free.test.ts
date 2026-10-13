import { mkdtemp,readFile,rm,copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect,vi } from 'vitest';
import { openSQLite } from '../server/sqlite';
import { ensureDB, hydrate } from '../server/db';
import { freeFetch } from '../server/free-runtime';
vi.mock('../server/adapters',()=>({collectSource:vi.fn(async(source:any)=>({jobs:[],status:source.id==='meta'?'blocked':'healthy',message:'Test collection result',complete:false}))}));
import { collectSource } from '../server/adapters';
import { SOURCES } from '../server/sources';
import { runScheduled, startRun, stepRun } from '../server/ingestion';
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
      const writer=openSQLite(path);try{await ensureDB(writer.db);}finally{writer.close();}
      const before=await readFile(path),reader=openSQLite(path,true),fetcher=freeFetch(reader.db);
      try {
        for(const route of ['/api/overview','/api/sources','/api/jobs?q=Data%20Labeling%20Analyst','/api/jobs?page=2','/api/jobs?sort=pay','/api/runs'])expect((await fetcher(new Request('https://atlas.test'+route))).status).toBe(200);
        const sources=await (await fetcher(new Request('https://atlas.test/api/sources'))).json() as any[];expect(sources.length).toBe(58);
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
      const run=await runScheduled(db);expect(run.status).toBe('partial');expect(run.sourceCount).toBe(58);expect(run.successCount).toBe(57);
      const after=await db.prepare("SELECT status,last_success_at FROM sources WHERE id='meta'").first<any>();
      expect(after.status).toBe('blocked');expect(after.last_success_at).toBe(before.last_success_at);
      expect((await db.prepare("SELECT count(*) AS n FROM jobs WHERE source_id='meta' AND active=1").first<any>()).n).toBe(count.n);
    }finally{close();}
  });
});

describe('source identity reconciliation',()=>{
  it('merges changed IDs and repeated URLs without resetting first seen or descriptions',async()=>{
    const {db,close}=openSQLite(':memory:');
    try {
      await ensureDB(db);
      const row=await db.prepare("SELECT * FROM jobs WHERE source_id='meta' LIMIT 1").first<any>();
      const old=hydrate(row),now=new Date().toISOString();
      vi.mocked(collectSource).mockResolvedValueOnce({status:'healthy',complete:true,message:'ok',jobs:[
        {...old,id:'meta:changed-id',description:'',firstSeenAt:now,lastSeenAt:now,postedAt:null},
        {...old,id:'meta:another-id',description:'',firstSeenAt:now,lastSeenAt:now,postedAt:null}
      ]});
      const run=await startRun(db);
      await db.prepare('UPDATE runs SET cursor=? WHERE id=?').bind(SOURCES.findIndex(s=>s.id==='meta'),run.id).run();
      const result=await stepRun(db,run.id);
      expect(result.newCount).toBe(0);expect(result.jobCount).toBe(1);
      const saved=hydrate(await db.prepare('SELECT * FROM jobs WHERE id=?').bind(old.id).first());
      expect(saved.id).toBe(old.id);expect(saved.firstSeenAt).toBe(old.firstSeenAt);
      expect(saved.description).toBe(old.description);expect(saved.postedAt).toBe(old.postedAt);
      expect(saved.lastSeenAt).toBe(now);
      expect((await db.prepare('SELECT count(*) n FROM jobs WHERE source_id=? AND apply_url=?').bind(old.sourceId,old.applyUrl).first<any>()).n).toBe(1);
    }finally{close();}
  });
  it('rolls back a bad source and continues the remaining sources',async()=>{
    const {db,close}=openSQLite(':memory:');
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      await ensureDB(db);
      const old=hydrate(await db.prepare("SELECT * FROM jobs WHERE source_id='meta' LIMIT 1").first());
      const history=await db.prepare("SELECT last_success_at FROM sources WHERE id='meta'").first<any>();
      vi.mocked(collectSource).mockResolvedValueOnce({status:'healthy',complete:true,retireExisting:true,message:'ok',jobs:[
        {...old,title:'Should roll back'}, {...old,id:'meta:invalid',applyUrl:old.applyUrl+'?different',location:null as any}
      ]});
      const run=await runScheduled(db);
      expect(run.status).toBe('partial');expect(run.successCount).toBe(57);
      const saved=hydrate(await db.prepare('SELECT * FROM jobs WHERE id=?').bind(old.id).first());
      expect(saved.title).toBe(old.title);expect(saved.active).toBe(true);
      const source=await db.prepare("SELECT status,last_success_at FROM sources WHERE id='meta'").first<any>();
      expect(source.status).toBe('error');expect(source.last_success_at).toBe(history.last_success_at);
    }finally{log.mockRestore();close();}
  });
});

describe('feed safety guards',()=>{
  it.each([
    {jobs:[],advertisedCount:undefined,retrievedCount:0},
    {jobs:[],advertisedCount:10,retrievedCount:0}
  ])('retains old roles when an empty or incomplete feed claims completeness',async feed=>{
    const {db,close}=openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare("UPDATE jobs SET last_seen_at='2020-01-01T00:00:00.000Z' WHERE source_id='meta'").run();
      const before=await db.prepare("SELECT count(*) n FROM jobs WHERE source_id='meta' AND active=1").first<any>();
      vi.mocked(collectSource).mockResolvedValueOnce({...feed,status:'healthy',complete:true,retireExisting:true,message:'test'});
      const run=await startRun(db);
      await db.prepare('UPDATE runs SET cursor=? WHERE id=?').bind(SOURCES.findIndex(s=>s.id==='meta'),run.id).run();
      await stepRun(db,run.id);
      expect((await db.prepare("SELECT count(*) n FROM jobs WHERE source_id='meta' AND active=1").first<any>()).n).toBe(before.n);
      expect((await db.prepare("SELECT complete FROM source_coverage WHERE source_id='meta'").first<any>()).complete).toBe(0);
    }finally{close();}
  });
  it('permits an explicitly confirmed empty feed to expire old listings',async()=>{
    const {db,close}=openSQLite(':memory:');
    try {
      await ensureDB(db);
      await db.prepare("UPDATE jobs SET last_seen_at='2020-01-01T00:00:00.000Z' WHERE source_id='meta'").run();
      vi.mocked(collectSource).mockResolvedValueOnce({jobs:[],advertisedCount:0,retrievedCount:0,status:'healthy',complete:true,message:'confirmed zero'});
      const run=await startRun(db);
      await db.prepare('UPDATE runs SET cursor=? WHERE id=?').bind(SOURCES.findIndex(s=>s.id==='meta'),run.id).run();
      await stepRun(db,run.id);
      expect((await db.prepare("SELECT count(*) n FROM jobs WHERE source_id='meta' AND active=1").first<any>()).n).toBe(0);
    }finally{close();}
  });
  it('continues after a collector throws unexpectedly',async()=>{
    const {db,close}=openSQLite(':memory:');
    try {
      await ensureDB(db);vi.mocked(collectSource).mockRejectedValueOnce(new Error('network reset'));
      const run=await runScheduled(db);expect(run.status).toBe('partial');expect(run.successCount).toBe(57);
    }finally{close();}
  });
});
