import { DatabaseSync } from 'node:sqlite';

export function openSQLite(path:string,readOnly=false) {
  const sqlite=new DatabaseSync(path,{readOnly});
  sqlite.exec('PRAGMA busy_timeout=5000');
  const prepare=(query:string)=>{
    let values:any[]=[];
    const statement={
      bind(...params:any[]){values=params;return statement;},
      async first(column?:string){const row=sqlite.prepare(query).get(...values);return column?row?.[column]??null:row??null;},
      async all(){return {results:sqlite.prepare(query).all(...values),success:true,meta:{}};},
      async raw(){const s=sqlite.prepare(query);s.setReturnArrays(true);return s.all(...values);},
      async run(){const r=sqlite.prepare(query).run(...values);return {success:true,results:[],meta:{changes:Number(r.changes)}};},
    };return statement;
  };
  const db={readOnly,prepare,async batch(statements:any[]){
    sqlite.exec('BEGIN');
    try {const out=[];for(const s of statements)out.push(await s.all());sqlite.exec('COMMIT');return out;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  },async exec(query:string){sqlite.exec(query);return {count:1,duration:0};}} as unknown as D1Database;
  return {db,close:()=>sqlite.close()};
}
