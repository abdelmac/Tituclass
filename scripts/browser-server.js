import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server.js';
const dir=await mkdtemp(join(tmpdir(),'medclass-browser-'));
const databasePath=join(dir,'demo.sqlite');
execFileSync(process.execPath,['scripts/seed.js'],{env:{...process.env,DATABASE_PATH:databasePath},stdio:'inherit'});
const app=createApp({databasePath,origin:'http://127.0.0.1:3100',secure:false});
app.server.listen(3100,'127.0.0.1',()=>console.log('Browser test server ready on http://127.0.0.1:3100'));
async function shutdown(){await app.close();await rm(dir,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
