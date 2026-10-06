import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, stat, unlink, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function makeBackup() {
  const source=resolve(process.env.DATABASE_PATH||'./data/medclass.sqlite');
  await stat(source); // Fail if missing; never silently back up a new empty database.
  const directory=resolve(process.env.BACKUP_PATH||'./data/backups');
  await mkdir(directory,{recursive:true});
  const filename=join(directory,`medclass-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
  const db=new DatabaseSync(source,{readOnly:true});
  try { await backup(db,filename); } finally {db.close();}
  const verification=new DatabaseSync(filename,{readOnly:true});
  try {if(verification.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup failed integrity check.');}finally{verification.close();}
  await chmod(filename,0o600);
  const days=Number(process.env.BACKUP_RETENTION_DAYS||30);
  if(!Number.isFinite(days)||days<1)throw Error('BACKUP_RETENTION_DAYS must be at least 1.');
  for(const name of await readdir(directory)) {
    if(!/^medclass-\d{4}-\d{2}-\d{2}T[\dZ-]+\.sqlite$/.test(name))continue;
    const file=join(directory,name);
    if((await stat(file)).mtimeMs<Date.now()-days*86400000)await unlink(file);
  }
  console.log('Verified database backup created:',filename);
  return filename;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await makeBackup();
