import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { passwordHash, now, hash } from '../lib/auth.js';

test('authenticated class workflows, isolation, live updates, revisions and persistence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'medclass-test-'));
  const path=join(directory,'test.sqlite');
  let app=createApp({databasePath:path});
  const listen=async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${app.server.address().port}`;};
  let origin=await listen();
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const db=app.db,password='TestPassword2026!';
  const stored=await passwordHash(password);
  for(const [uid,name] of [['admin','Admin'],['editor','Editor'],['student','Student'],['other','Other']])db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(uid,name,uid+'@test.edu',stored,now());
  for(const cid of ['medicine','dentistry'])db.prepare('INSERT INTO classes(id,name,timezone) VALUES (?,?,?)').run(cid,cid,'Europe/Paris');
  for(const [uid,role,cid,group] of [['admin','admin','medicine',''],['editor','editor','medicine',''],['student','student','medicine','A'],['other','student','dentistry','']])db.prepare('INSERT INTO members(class_id,user_id,role,subgroup) VALUES (?,?,?,?)').run(cid,uid,role,group);
  const request=async(path,method='GET',body,session)=>{
    const response=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{} )},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async uid=>{const result=await request('/auth/login','POST',{email:uid+'@test.edu',password});assert.equal(result.status,200);return {cookie:result.cookie,csrf:result.body.csrf};};
  const admin=await login('admin'),editor=await login('editor'),student=await login('student'),other=await login('other');
  const root='/classes/medicine';
  let eventId;
  await t.test('admin creates; student views; attendance defaults Unknown',async()=>{
    const result=await request(root+'/events','POST',{title:'Cardiology',subject:'Physiology',date:'2026-10-06',start:'09:00',end:'10:00'},admin);
    assert.equal(result.status,201);eventId=result.body.ids[0];
    const result2=await request(root,'GET',undefined,student);assert.equal(result2.status,200);
    assert.equal(result2.body.events[0].attendance,'unknown');assert.equal(result2.body.events[0].room,'');assert.equal(result2.body.events[0].version,1);
  });
  await t.test('students cannot edit, invite, manage members or create classes',async()=>{
    for(const [path,method,body] of [[root+'/events','POST',{title:'Bad',subject:'Bad'}],[root+'/events/'+eventId,'PATCH',{title:'Bad',subject:'Bad',version:1}],[root+'/members/admin','PATCH',{role:'admin'}],[root+'/invitations','POST',{}],['/classes','POST',{name:'Bad',timezone:'Europe/Paris'}]])assert.equal((await request(path,method,body,student)).status,403);
    assert.equal((await request(root+'/members','GET',undefined,student)).status,403);
    assert.equal((await request(root+'/events/'+eventId+'/history','GET',undefined,student)).status,403);
  });
  await t.test('class membership and object isolation enforced on server',async()=>{
    for(const path of [root,root+'/stream',root+'/events/'+eventId+'/history',root+'/members'])assert.equal((await request(path,'GET',undefined,other)).status,403);
    assert.equal((await request('/classes/dentistry','GET',undefined,student)).status,403);
  });
  await t.test('room and attendance change reaches a connected student session',async()=>{
    const controller=new AbortController();
    const response=await fetch(origin+'/api'+root+'/stream',{headers:{Cookie:student.cookie},signal:controller.signal});
    assert.equal(response.status,200);const reader=response.body.getReader();
    const ready=await reader.read();assert.match(new TextDecoder().decode(ready.value),/event: ready/);
    const result=await request(root+'/events/'+eventId,'PATCH',{title:'Cardiology',subject:'Physiology',date:'2026-10-06',start:'09:00',end:'10:00',room:'B04',attendance:'required',version:1},editor);
    assert.equal(result.status,200);
    let timeout;try{const message=await Promise.race([reader.read(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('No live event within 3 seconds')),3000);})]);assert.match(new TextDecoder().decode(message.value),/event: change/);}finally{clearTimeout(timeout);controller.abort();}
    const data=(await request(root,'GET',undefined,student)).body;
    assert.equal(data.events[0].room,'B04');assert.equal(data.events[0].attendance,'required');
    assert.match(data.notifications[0].message,/Attendance changed from Unknown to Required/);
    assert.equal(data.notifications[0].author,'Editor');
  });
  await t.test('stale editor writes are rejected and admins can restore history',async()=>{
    const result=await request(root+'/events/'+eventId,'PATCH',{title:'Lost edit',subject:'Physiology',version:1},admin);assert.equal(result.status,409);
    const history=await request(root+'/events/'+eventId+'/history','GET',undefined,admin);assert.equal(history.body.length,2);assert.equal(history.body[0].author,'Editor');
    assert.equal((await request(root+'/events/'+eventId+'/restore','POST',{restoreVersion:1,version:2},editor)).status,403);
    assert.equal((await request(root+'/events/'+eventId+'/restore','POST',{restoreVersion:1,version:2},admin)).status,200);
    const restored=(await request(root,'GET',undefined,student)).body.events[0];assert.equal(restored.version,3);assert.equal(restored.attendance,'unknown');
  });
  await t.test('subgroups isolate events, announcements and notifications',async()=>{
    const created=await request(root+'/events','POST',{title:'Group B private lab',subject:'Anatomy',subgroup:'B'},admin);assert.equal(created.status,201);
    await request(root+'/announcements','POST',{title:'Group B private notice',message:'Private information',priority:'urgent',subgroup:'B'},editor);
    const data=(await request(root,'GET',undefined,student)).body;
    assert.ok(!data.events.some(e=>e.subgroup==='B'));assert.ok(!data.announcements.some(e=>e.subgroup==='B'));assert.ok(!data.notifications.some(e=>e.subgroup==='B'));
    assert.equal((await request(root+'/events/'+created.body.ids[0]+'/history','GET',undefined,student)).status,404);
  });
  await t.test('invitation registration never grants elevated permissions; revoked links fail',async()=>{
    const invite=(await request(root+'/invitations','POST',{days:7,subgroup:'A'},admin)).body;
    const reg=await request('/auth/register','POST',{name:'New student',email:'new@test.edu',password,code:invite.code,role:'admin'});assert.equal(reg.status,201);
    const newStudent={cookie:reg.cookie,csrf:reg.body.csrf};const me=await request('/me','GET',undefined,newStudent);assert.equal(me.body.classes[0].role,'student');assert.equal(me.body.classes[0].subgroup,'A');
    await request(root+'/invitations/'+invite.id,'DELETE',{},admin);
    assert.equal((await request('/join','POST',{code:invite.code},other)).status,400);
    assert.equal((await request('/auth/register','POST',{name:'Rejected',email:'rejected@test.edu',password,code:invite.code})).status,400);
    db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?)').run('expired','medicine',hash('expired'),'','2020-01-01T00:00:00.000Z',0,now());
    assert.equal((await request('/join','POST',{code:'expired'},other)).status,400);
  });
  await t.test('notification read state belongs to each user and survives reload',async()=>{
    const notification=(await request(root,'GET',undefined,student)).body.notifications[0];
    assert.equal((await request(root+'/notifications/'+notification.id+'/read','POST',{},student)).status,200);
    assert.equal((await request(root,'GET',undefined,student)).body.notifications.find(n=>n.id===notification.id).is_read,1);
    assert.equal((await request(root,'GET',undefined,editor)).body.notifications.find(n=>n.id===notification.id).is_read,0);
  });
  await t.test('weekly series supports one occurrence and all; detects series conflicts',async()=>{
    const payload={title:'Recurring lab',subject:'Anatomy',date:'2026-10-08',start:'10:00',end:'11:00',repeatCount:4};
    const created=await request(root+'/events','POST',payload,admin);assert.equal(created.body.ids.length,4);
    const data=(await request(root,'GET',undefined,admin)).body.events.filter(e=>created.body.ids.includes(e.id));
    assert.deepEqual(data.map(e=>e.date),['2026-10-08','2026-10-15','2026-10-22','2026-10-29']);
    const versions=Object.fromEntries(data.map(e=>[e.id,e.version]));
    assert.equal((await request(root+'/events/'+data[0].id,'PATCH',{...data[0],scope:'series',seriesVersions:versions,room:'C10',date:'2026-10-09'},admin)).status,200);
    let series=(await request(root,'GET',undefined,admin)).body.events.filter(e=>created.body.ids.includes(e.id));
    assert.deepEqual(series.map(e=>e.date),['2026-10-09','2026-10-16','2026-10-23','2026-10-30']);assert.ok(series.every(e=>e.room==='C10'));
    const before=Object.fromEntries(series.map(e=>[e.id,e.version]));
    await request(root+'/events/'+series[1].id,'PATCH',{...series[1],room:'D20'},editor);
    assert.equal((await request(root+'/events/'+series[0].id,'PATCH',{...series[0],scope:'series',seriesVersions:before,room:'Z99'},admin)).status,409);
    series=(await request(root,'GET',undefined,admin)).body.events.filter(e=>created.body.ids.includes(e.id));assert.equal(series[0].room,'C10');assert.equal(series[1].room,'D20');
  });
  await t.test('cancelled sessions and unconfirmed fields remain visible; invalid inputs rejected',async()=>{
    const created=await request(root+'/events','POST',{title:'Cancelled tutorial',subject:'Clinical medicine',status:'cancelled'},admin);
    const data=(await request(root,'GET',undefined,student)).body.events.find(e=>e.id===created.body.ids[0]);assert.equal(data.status,'cancelled');assert.equal(data.date,'');assert.equal(data.start,'');assert.equal(data.attendance,'unknown');
    for(const body of [{date:'2026-99-99'},{attendance:'optional'},{meeting:'javascript:alert(1)'},{start:'11:00',end:'10:00'},{date:'2026-02-30'}])assert.equal((await request(root+'/events','POST',{title:'Bad data',subject:'Bad',...body},admin)).status,400);
    assert.equal((await request(root+'/announcements','POST',{title:'Pin',message:'Message',priority:'normal',pinned:true},editor)).status,403);
  });
  await t.test('CSRF, unauthenticated access and last-admin protections',async()=>{
    assert.equal((await request(root)).status,401);
    assert.equal((await request(root+'/events','POST',{title:'Bad',subject:'Bad'},{...admin,csrf:'bad'})).status,403);
    assert.equal((await request(root+'/members/admin','DELETE',{},admin)).status,400);
    assert.equal((await request(root+'/members/admin','PATCH',{role:'student'},admin)).status,400);
    const response=await fetch(origin+'/api'+root+'/events',{method:'POST',headers:{Cookie:admin.cookie,'X-CSRF-Token':admin.csrf,'Content-Type':'application/json',Origin:'https://evil.test'},body:JSON.stringify({title:'Bad',subject:'Bad'})});assert.equal(response.status,403);
  });
  await t.test('saved data and sessions survive server restart',async()=>{
    const before=(await request(root,'GET',undefined,student)).body;
    await app.close();app=createApp({databasePath:path});origin=await listen();
    const after=await request(root,'GET',undefined,student);assert.equal(after.status,200);assert.deepEqual(after.body.events,before.events);assert.deepEqual(after.body.notifications,before.notifications);
  });
  await t.test('removing a member immediately revokes content access',async()=>{
    assert.equal((await request(root+'/members/student','DELETE',{},admin)).status,200);
    assert.equal((await request(root,'GET',undefined,student)).status,403);
    assert.equal((await request('/auth/logout','POST',{},editor)).status,200);
    assert.equal((await request(root,'GET',undefined,editor)).status,401);
  });
});
