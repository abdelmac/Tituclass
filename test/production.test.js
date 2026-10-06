import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';
import { hash, id, token, now, passwordHash } from '../lib/auth.js';
import { makeBackup } from '../scripts/backup.js';

test('bounded feed, unread totals, subgroup cursors, health and verified live backup',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'medclass-prod-')),path=join(dir,'db.sqlite');
  const app=createApp({databasePath:path});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${app.server.address().port}`,session=token();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  app.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('student','Student','student@test.edu',await passwordHash('TestPassword2026!'),now());
  app.db.prepare('INSERT INTO classes(id,name,timezone) VALUES (?,?,?)').run('class','Class','Europe/Paris');
  app.db.prepare('INSERT INTO members(class_id,user_id,role,subgroup) VALUES (?,?,?,?)').run('class','student','student','A');
  app.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(session),'student','csrf',Date.now()+100000);
  const time=now(),insert=app.db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<205;i++)insert.run(id(),'class','','Visible notification '+i,'Message','change',null,'student',time);
  insert.run('private','class','B','Private title','Private message','announcement',null,'student',time);
  const get=async path=>{const r=await fetch(origin+path,{headers:{Cookie:'medclass_session='+session}});return {status:r.status,body:await r.json()};};
  const first=(await get('/api/classes/class')).body;assert.equal(first.notifications.length,100);assert.equal(first.unreadCount,205);assert.equal(first.notificationMore,true);
  const second=(await get('/api/classes/class/notifications?before='+first.notifications.at(-1).id)).body;
  const third=(await get('/api/classes/class/notifications?before='+second.notifications.at(-1).id)).body;
  assert.equal(second.notifications.length,100);assert.equal(third.notifications.length,5);assert.equal(third.notificationMore,false);
  assert.equal(new Set([...first.notifications,...second.notifications,...third.notifications].map(n=>n.id)).size,205);
  assert.equal((await get('/api/classes/class/notifications?before=private')).status,404);
  assert.equal((await get('/healthz')).body.ok,true);assert.equal((await get('/api/config')).body.demoAvailable,false);
  const oldPath=process.env.DATABASE_PATH,oldBackup=process.env.BACKUP_PATH;
  process.env.DATABASE_PATH=path;process.env.BACKUP_PATH=join(dir,'backups');
  try{
    const filename=await makeBackup(),backup=new DatabaseSync(filename,{readOnly:true});
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM notifications').get().count,206);backup.close();
  }finally{if(oldPath===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=oldPath;if(oldBackup===undefined)delete process.env.BACKUP_PATH;else process.env.BACKUP_PATH=oldBackup;}
});
