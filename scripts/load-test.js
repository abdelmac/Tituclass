import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server.js';
import { id, now, passwordHash } from '../lib/auth.js';
import { transaction } from '../lib/db.js';
import { validateEvent } from '../lib/events.js';

const users=Number(process.env.LOAD_USERS||200),writes=Number(process.env.LOAD_CHANGES||50),historySize=18250;
if(!Number.isInteger(users)||users<1||users>1000||!Number.isInteger(writes)||writes<1||writes>500)throw Error('Use 1–1000 users and 1–500 changes.');
const directory=await mkdtemp(join(tmpdir(),'medclass-load-'));
const app=createApp({databasePath:join(directory,'load.sqlite')});
const controllers=[],streams=[];
const timings={login:[],read:[],write:[]};
const percentile=values=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*.95))];
async function pool(list,concurrency,fn){let i=0;await Promise.all(Array.from({length:Math.min(concurrency,list.length)},async()=>{while(i<list.length)await fn(list[i++]);}));}
try{
  const password='TemporaryLoadTest2026!',stored=await passwordHash(password),eventId=id();
  transaction(app.db,()=>{
    app.db.prepare('INSERT INTO classes(id,name,timezone) VALUES (?,?,?)').run('load','Load test','Europe/Paris');
    for(let i=0;i<=users;i++){
      app.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('user-'+i,'Load user '+i,`user-${i}@load.test`,stored,now());
      app.db.prepare('INSERT INTO members(class_id,user_id,role) VALUES (?,?,?)').run('load','user-'+i,i===0?'admin':'student');
    }
    const event=validateEvent({title:'Load test session',subject:'Anatomy',date:'2026-10-06',room:'A12'});
    const time=now();app.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(eventId,'load',null,JSON.stringify(event),1,time,'user-0');
    app.db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)').run(id(),eventId,'load',1,JSON.stringify(event),'[]','user-0',time);
    // One year of 50 daily updates. Also add 250 schedule items to the payload.
    for(let i=0;i<250;i++)app.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(id(),'load',null,JSON.stringify({...event,title:'Session '+i}),1,time,'user-0');
    const insert=app.db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<historySize;i++)insert.run(id(),'load','','Previous schedule change','Room changed from A12 to B04. Attendance changed from Unknown to Required.','change',eventId,'user-0',new Date(Date.now()-86400000-(historySize-i)*1000).toISOString());
  });
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${app.server.address().port}`,sessions=[];
  async function request(path,session,body,method=body?'POST':'GET'){
    const start=performance.now();const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(`${response.status}: ${result.error}`);
    const ms=performance.now()-start;timings[path==='/api/auth/login'?'login':method==='GET'?'read':'write'].push(ms);
    return {result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  console.log(`Testing ${users} connected students, ${writes} updates, ${historySize} historical notifications, 251 events.`);
  await pool(Array.from({length:users+1},(_,i)=>i),20,async i=>{
    const response=await request('/api/auth/login',null,{email:`user-${i}@load.test`,password});sessions[i]={cookie:response.cookie,csrf:response.result.csrf};
  });
  await pool(sessions.slice(1),25,async session=>{
    const controller=new AbortController();controllers.push(controller);
    const response=await fetch(origin+'/api/classes/load/stream',{headers:{Cookie:session.cookie},signal:controller.signal});
    if(!response.ok)throw Error('Stream connection failed.');
    const reader=response.body.getReader();let resolveReady;const ready=new Promise(r=>resolveReady=r);
    const stream={count:0,session};streams.push(stream);
    stream.task=(async()=>{let buffer='';try{while(true){const item=await reader.read();if(item.done)break;buffer+=new TextDecoder().decode(item.value);let index;while((index=buffer.indexOf('\n\n'))>=0){const message=buffer.slice(0,index);buffer=buffer.slice(index+2);if(message.includes('event: ready'))resolveReady();if(message.includes('event: change'))stream.count++;}}}catch(error){if(error.name!=='AbortError')throw error;}})();
    await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Stream ready timed out')),10000);timer.unref();})]);
  });
  await pool(sessions.slice(1),users,async session=>{const {result}=await request('/api/classes/load',session);if(result.notifications.length!==100||result.unreadCount!==historySize)throw Error('Incorrect notification pagination/count.');});
  const burstStart=performance.now();
  for(let i=0;i<writes;i++)await request('/api/classes/load/events/'+eventId,sessions[0],{title:'Load test session',subject:'Anatomy',date:'2026-10-06',room:'B'+String(i).padStart(2,'0'),attendance:'required',version:i+1},'PATCH');
  const deadline=Date.now()+10000;
  while(streams.some(s=>s.count<writes)){if(Date.now()>deadline)throw Error('Not all students received all updates.');await new Promise(r=>setTimeout(r,20));}
  const burstMs=performance.now()-burstStart;
  await pool(sessions.slice(1),users,async session=>{const {result}=await request('/api/classes/load',session);const event=result.events.find(e=>e.id===eventId);if(event.version!==writes+1||event.room!=='B'+String(writes-1).padStart(2,'0'))throw Error('Student saw stale final event.');});
  console.log(JSON.stringify({users,changes:writes,liveDeliveries:streams.reduce((sum,s)=>sum+s.count,0),historicalNotifications:historySize,burstSeconds:Number((burstMs/1000).toFixed(2)),loginP95Ms:Math.round(percentile(timings.login)),classReadP95Ms:Math.round(percentile(timings.read)),publishP95Ms:Math.round(percentile(timings.write)),rssMiB:Math.round(process.memoryUsage().rss/1048576),errors:0},null,2));
}finally{
  controllers.forEach(c=>c.abort());await Promise.allSettled(streams.map(s=>s.task));await app.close();await rm(directory,{recursive:true,force:true});
}
