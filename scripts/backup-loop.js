import { makeBackup } from './backup.js';
const hours=Number(process.env.BACKUP_INTERVAL_HOURS||6);
if(!Number.isFinite(hours)||hours<1)throw Error('BACKUP_INTERVAL_HOURS must be at least 1.');
async function run(){try{await makeBackup();}catch(error){console.error('Backup failed:',error.message);}}
await run();setInterval(run,hours*3600000);
