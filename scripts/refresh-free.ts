import { openSQLite } from '../server/sqlite';
import { ensureDB } from '../server/db';
import { runScheduled } from '../server/ingestion';
import { pruneSnapshot } from '../server/prune';
import { writeFile } from 'node:fs/promises';
import { trainPayModel } from '../server/pay-model';
const {db,close}=openSQLite('data/atlas.sqlite');
try {
  await ensureDB(db);
  const run=await runScheduled(db);
  if(run.status==='failed')throw new Error('No source connected; previous snapshot remains available.');
  if(process.env.GITHUB_ACTIONS==='true')await db.prepare("INSERT INTO settings(key,value) VALUES('schedule_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const pruned=await pruneSnapshot(db);
  await db.exec('VACUUM');
  // The pay model is refitted on every refresh so estimates follow the
  // current snapshot. Only its coefficients ship with the site.
  const payModel=await trainPayModel(db);
  await writeFile('data/pay-model.json',JSON.stringify(payModel)+'\n');
  const payRoles=Object.fromEntries(Object.entries(payModel.currencies).map(([currency,m])=>[currency,m.roles]));
  console.log(JSON.stringify({...run,pruned,payRoles}));
}finally{close();}
