import { openSQLite } from '../server/sqlite';
import { ensureDB, markDuplicates } from '../server/db';
import { runScheduled } from '../server/ingestion';
import { pruneSnapshot } from '../server/prune';
import { writeFile } from 'node:fs/promises';
import { trainPayModel } from '../server/pay-model';
import { enrichPending, providersFromEnv, runOptionsFromEnv } from '../server/enrichment';
import { collectStartups } from '../server/startups/collect';
const {db,close}=openSQLite('data/atlas.sqlite');
try {
  await ensureDB(db);
  const run=await runScheduled(db);
  if(run.status==='failed')throw new Error('No source connected; previous snapshot remains available.');
  if(process.env.GITHUB_ACTIONS==='true')await db.prepare("INSERT INTO settings(key,value) VALUES('schedule_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const pruned=await pruneSnapshot(db);
  // Pruning can remove a role that kept a repost hidden, so flags are
  // recomputed on the rows that actually ship.
  const duplicates=await markDuplicates(db);
  // Enrichment runs on the roles that ship, after pruning and flags, so no
  // calls are spent on rows that are about to be deleted or hidden. It never
  // throws, and without GROQ_API_KEY or GEMINI_API_KEY it does nothing.
  const enrichment=await enrichPending(db,providersFromEnv(),runOptionsFromEnv());
  if(enrichment.status==='error'||enrichment.status==='stopped')console.warn(`Enrichment ${enrichment.status}; the refresh continues.`,enrichment.error??'');
  // StartupAtlas reads public startup job boards into its own tables. It is
  // separate from the contract feed, and a failure here never stops the refresh.
  let startups:unknown;
  try { startups=await collectStartups(db); }
  catch(error) { startups={error:error instanceof Error?error.message:String(error)}; console.warn('StartupAtlas collection failed; the refresh continues.',startups); }
  await db.exec('VACUUM');
  // The pay model is refitted on every refresh so estimates follow the
  // current snapshot. Only its coefficients ship with the site.
  const payModel=await trainPayModel(db);
  await writeFile('data/pay-model.json',JSON.stringify(payModel)+'\n');
  const payRoles=Object.fromEntries(Object.entries(payModel.currencies).map(([currency,m])=>[currency,m.roles]));
  console.log(JSON.stringify({...run,pruned,duplicates,payRoles,enrichment,startups}));
}finally{close();}
