import { openSQLite } from '../server/sqlite';
import { ensureDB } from '../server/db';
import { runScheduled } from '../server/ingestion';
const {db,close}=openSQLite('data/atlas.sqlite');
try {
  await ensureDB(db);
  const run=await runScheduled(db);
  if(run.status==='failed')throw new Error('No source connected; previous snapshot remains available.');
  if(process.env.GITHUB_ACTIONS==='true')await db.prepare("INSERT INTO settings(key,value) VALUES('schedule_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  console.log(JSON.stringify(run));
}finally{close();}
