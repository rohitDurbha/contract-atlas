import { mkdir } from 'node:fs/promises';
import { openSQLite } from '../server/sqlite';
import { ensureDB } from '../server/db';
await mkdir('data',{recursive:true});
const {db,close}=openSQLite('data/atlas.sqlite');
try {await ensureDB(db);console.log('SQLite bootstrap snapshot ready.');}finally{close();}
