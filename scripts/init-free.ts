import { mkdir } from 'node:fs/promises';
import { openSQLite } from '../server/sqlite';
import { ensureDB, markDuplicates } from '../server/db';
await mkdir('data',{recursive:true});
const {db,close}=openSQLite('data/atlas.sqlite');
try {
  await ensureDB(db);
  // A snapshot from before the duplicate column, or one built on another
  // day, gets fresh repost flags before it is bundled with the site.
  const flagged=await markDuplicates(db);
  console.log(`SQLite bootstrap snapshot ready with ${flagged} reposts flagged.`);
}finally{close();}
