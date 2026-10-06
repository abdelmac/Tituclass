import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { openDatabase, transaction } from './lib/db.js';
import { id, now, token, hash, passwordHash, passwordMatches, fail, text, credentials } from './lib/auth.js';
import { validateEvent, serializeEvent, changes } from './lib/events.js';

const publicPath = fileURLToPath(new URL('./public/', import.meta.url));
export function createApp({ databasePath, origin = process.env.APP_ORIGIN, secure = process.env.COOKIE_SECURE === 'true' } = {}) {
  const db = openDatabase(databasePath);
  const streams = new Set();
  const attempts = new Map();
  const member = (classId, userId, roles) => {
    const m = db.prepare('SELECT * FROM members WHERE class_id=? AND user_id=?').get(classId, userId);
    if (!m || (roles && !roles.includes(m.role))) fail(403, 'You do not have permission to access or change this class.');
    return m;
  };
  const visible = (subgroup, m) => m.role !== 'student' || !subgroup || subgroup === m.subgroup;
  const notify = (classId, subgroup, title, message, kind, eventId, userId) => db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)').run(id(), classId, subgroup, title, message, kind, eventId || null, userId, now());
  const broadcast = classId => {
    for (const stream of streams) {
      const session = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(stream.token, Date.now());
      const m = session && db.prepare('SELECT 1 FROM members WHERE class_id=? AND user_id=?').get(classId, stream.userId);
      if (!session || !db.prepare('SELECT 1 FROM members WHERE class_id=? AND user_id=?').get(stream.classId,stream.userId)) { stream.res.end(); streams.delete(stream); }
      else if (m && stream.classId === classId) stream.res.write('event: change\ndata: {}\n\n');
    }
  };
  const cookie = value => `medclass_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value ? 604800 : 0}${secure ? '; Secure' : ''}`;
  const login = (res, userId) => {
    const value = token(), csrf = token();
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(value), userId, csrf, Date.now() + 7 * 86400000);
    res.setHeader('Set-Cookie',cookie(value)); return csrf;
  };
  const json = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
  const limited = key => {
    const record = attempts.get(key) || { count:0, until:Date.now() + 15*60000 };
    if (record.until < Date.now()) { record.count = 0; record.until = Date.now() + 15*60000; }
    record.count++; attempts.set(key,record);
    if (record.count > 20) fail(429, 'Too many attempts. Please try again in 15 minutes.');
    if (attempts.size > 10000) for (const [k,v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  };
  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url,'http://localhost'), path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405,'Method not allowed.');
        const files = {'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/icon.svg':'icon.svg'};
        if (!files[path]) fail(404,'Page not found.');
        const buffer = await readFile(resolve(publicPath,files[path]));
        res.setHeader('Content-Type', {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[extname(files[path])]);
        res.setHeader('Cache-Control','no-cache'); res.end(req.method === 'HEAD' ? undefined : buffer); return;
      }
      res.setHeader('Cache-Control','no-store');
      const mutating = !['GET','HEAD'].includes(req.method);
      if (mutating) {
        const expected = origin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expected) fail(403,'Request origin does not match.');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403,'Cross-site requests are not allowed.');
        if (!req.headers['content-type']?.startsWith('application/json')) fail(415,'Use JSON requests.');
      }
      let body = {};
      if (mutating) {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 64000) fail(413,'Request is too large.'); }
        try { body = JSON.parse(raw || '{}'); } catch { fail(400,'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400,'Invalid request.');
      }
      const sessionValue = req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('medclass_session='))?.slice(17);
      const session = sessionValue && db.prepare('SELECT s.*,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(hash(sessionValue),Date.now());
      if (path === '/api/auth/login' && req.method === 'POST') {
        limited(req.socket.remoteAddress);
        const { email, password } = credentials(body);
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        // Derive a dummy hash as well, so unknown accounts take comparable time.
        const ok = user ? await passwordMatches(password,user.password) : (await passwordHash(password),false);
        if (!ok) fail(401,'Email or password is incorrect.');
        return json(res,200,{csrf:login(res,user.id)});
      }
      if (path === '/api/auth/register' && req.method === 'POST') {
        limited(req.socket.remoteAddress);
        const {email,password} = credentials(body), name = text(body.name,'name',100,true);
        const code = text(body.code,'invitation code',150,true);
        const passwordValue = await passwordHash(password);
        const userId = id();
        transaction(db,()=>{
          const invitation = db.prepare('SELECT * FROM invitations WHERE code_hash=? AND revoked=0 AND expires_at>?').get(hash(code),now());
          if (!invitation) fail(400,'This invitation is invalid, expired, or revoked.');
          if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409,'An account with this email already exists. Sign in to join.');
          db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(userId,name,email,passwordValue,now());
          db.prepare('INSERT INTO members(class_id,user_id,role,subgroup) VALUES (?,?,?,?)').run(invitation.class_id,userId,'student',invitation.subgroup);
        });
        return json(res,201,{csrf:login(res,userId)});
      }
      if (!session) fail(401,'Please sign in to continue.');
      if (mutating && req.headers['x-csrf-token'] !== session.csrf) fail(403,'Your session needs refreshing. Reload and try again.');
      if (path === '/api/auth/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);
        for (const s of streams) if (s.token === session.token) { s.res.end(); streams.delete(s); }
        res.setHeader('Set-Cookie',cookie('')); return json(res,200,{ok:true});
      }
      if (path === '/api/me' && req.method === 'GET') {
        const classes = db.prepare('SELECT c.*,m.role,m.subgroup,m.last_visit FROM classes c JOIN members m ON c.id=m.class_id WHERE m.user_id=? ORDER BY c.name').all(session.user_id);
        return json(res,200,{user:{id:session.user_id,name:session.name,email:session.email},csrf:session.csrf,classes});
      }
      if (path === '/api/join' && req.method === 'POST') {
        limited(session.user_id);
        const invitation = db.prepare('SELECT * FROM invitations WHERE code_hash=? AND revoked=0 AND expires_at>?').get(hash(text(body.code,'invitation code',150,true)),now());
        if (!invitation) fail(400,'This invitation is invalid, expired, or revoked.');
        db.prepare('INSERT OR IGNORE INTO members(class_id,user_id,role,subgroup) VALUES (?,?,?,?)').run(invitation.class_id,session.user_id,'student',invitation.subgroup);
        return json(res,200,{classId:invitation.class_id});
      }
      if (path === '/api/classes' && req.method === 'POST') {
        if (!db.prepare("SELECT 1 FROM members WHERE user_id=? AND role='admin'").get(session.user_id)) fail(403,'Only an administrator can create a class.');
        const name=text(body.name,'class name',100,true), timezone=text(body.timezone,'timezone',100,true);
        try { new Intl.DateTimeFormat('en',{timeZone:timezone}); } catch { fail(400,'Use a valid IANA timezone, such as Europe/Paris.'); }
        const classId=id(); transaction(db,()=>{
          db.prepare('INSERT INTO classes(id,name,timezone) VALUES (?,?,?)').run(classId,name,timezone);
          db.prepare('INSERT INTO members(class_id,user_id,role) VALUES (?,?,?)').run(classId,session.user_id,'admin');
        }); return json(res,201,{id:classId});
      }
      const match = path.match(/^\/api\/classes\/([^/]+)(?:\/(.*))?$/);
      if (!match) fail(404,'API route not found.');
      const [,classId, route = ''] = match, m = member(classId,session.user_id);
      const editor = () => member(classId,session.user_id,['admin','editor']);
      const admin = () => member(classId,session.user_id,['admin']);
      if (route === 'stream' && req.method === 'GET') {
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write('event: ready\ndata: {}\n\n');
        const stream = {res,userId:session.user_id,classId,token:session.token}; streams.add(stream);
        req.on('close',()=>streams.delete(stream)); return;
      }
      if (route === '' && req.method === 'GET') {
        const events=db.prepare('SELECT * FROM events WHERE class_id=?').all(classId).map(serializeEvent).filter(e=>visible(e.subgroup,m));
        const announcements=db.prepare('SELECT a.*,u.name AS author FROM announcements a JOIN users u ON u.id=a.author_id WHERE class_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY pinned DESC,updated_at DESC').all(classId,now()).filter(a=>visible(a.subgroup,m));
        const notifications=db.prepare('SELECT n.*,u.name AS author,EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=?) AS is_read FROM notifications n JOIN users u ON u.id=n.author_id WHERE n.class_id=? ORDER BY n.created_at DESC').all(session.user_id,classId).filter(n=>visible(n.subgroup,m));
        return json(res,200,{class:db.prepare('SELECT * FROM classes WHERE id=?').get(classId),role:m.role,subgroup:m.subgroup,lastVisit:m.last_visit,events,announcements,notifications,serverTime:now()});
      }
      if (route === 'visit' && req.method === 'POST') {
        db.prepare('UPDATE members SET last_visit=? WHERE class_id=? AND user_id=?').run(now(),classId,session.user_id); return json(res,200,{ok:true});
      }
      if (route === 'settings' && req.method === 'PATCH') {
        admin(); const name=text(body.name,'class name',100,true), timezone=text(body.timezone,'timezone',100,true);
        try { new Intl.DateTimeFormat('en',{timeZone:timezone}); } catch { fail(400,'Enter a valid IANA timezone.'); }
        db.prepare('UPDATE classes SET name=?,timezone=? WHERE id=?').run(name,timezone,classId); broadcast(classId); return json(res,200,{ok:true});
      }
      if (route === 'events' && req.method === 'POST') {
        editor(); const data=validateEvent(body), count=Number(body.repeatCount || 1);
        if (!Number.isInteger(count) || count<1 || count>52 || (count>1 && !data.date)) fail(400,'Recurrence needs a confirmed date and 1–52 weekly occurrences.');
        const seriesId=count>1?id():null, result=[];
        transaction(db,()=>{
          for (let i=0;i<count;i++) {
            const d={...data}; if (i) { const date=new Date(data.date+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+i*7); d.date=date.toISOString().slice(0,10); }
            validateEvent(d);
            const eventId=id(), time=now();
            db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(eventId,classId,seriesId,JSON.stringify(d),1,time,session.user_id);
            db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)').run(id(),eventId,classId,1,JSON.stringify(d),'[]',session.user_id,time);
            result.push(eventId);
          }
          notify(classId,data.subgroup,`New ${data.type}: ${data.title}`,`${count>1?count+' weekly occurrences published.':'Added to your schedule.'}`, 'event',result[0],session.user_id);
        }); broadcast(classId); return json(res,201,{ids:result});
      }
      const eventMatch=route.match(/^events\/([^/]+)(?:\/(history|restore))?$/);
      if (eventMatch) {
        const [,eventId,action]=eventMatch;
        const row=db.prepare('SELECT * FROM events WHERE id=? AND class_id=?').get(eventId,classId);
        if (!row || !visible(JSON.parse(row.data).subgroup,m)) fail(404,'Event not found.');
        if (action==='history' && req.method==='GET') {
          editor(); return json(res,200,db.prepare('SELECT h.*,u.name AS author FROM history h JOIN users u ON u.id=h.author_id WHERE h.event_id=? ORDER BY h.version DESC').all(eventId).map(h=>({...h,data:JSON.parse(h.data),changed_fields:JSON.parse(h.changed_fields)})));
        }
        if ((!action && req.method==='PATCH') || (action==='restore' && req.method==='POST')) {
          editor();
          let data;
          if (action==='restore') {
            admin(); const version=db.prepare('SELECT data FROM history WHERE event_id=? AND version=?').get(eventId,Number(body.restoreVersion));
            if (!version) fail(404,'Earlier version not found.'); data=JSON.parse(version.data);
          } else data=validateEvent(body);
          const oldData=JSON.parse(row.data);
          if (Number(body.version)!==row.version) fail(409,'Someone else updated this event. Reload the latest version before publishing your changes.');
          let updatedIds=[];
          transaction(db,()=>{
            let rows=[row];
            if (body.scope==='series') {
              if (!row.series_id) fail(400,'This event has no recurring series.');
              rows=db.prepare('SELECT * FROM events WHERE series_id=? AND class_id=?').all(row.series_id,classId);
              if (!body.seriesVersions || rows.some(r=>body.seriesVersions[r.id]!==r.version)) fail(409,'A series occurrence has changed. Reload the schedule before publishing.');
            }
            for (const r of rows) {
              const previous=JSON.parse(r.data), next={...previous};
              if (body.scope==='series') {
                for (const change of changes(oldData,data)) {
                  if (change.field==='date' && previous.date && oldData.date && data.date) {
                    const offset=(new Date(data.date+'T12:00:00Z')-new Date(oldData.date+'T12:00:00Z'))/86400000;
                    const date=new Date(previous.date+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+offset); next.date=date.toISOString().slice(0,10);
                  } else next[change.field]=data[change.field];
                }
              } else Object.assign(next,data);
              validateEvent(next);
              const changed=changes(previous,next); if (!changed.length) continue;
              const time=now();
              const update=db.prepare('UPDATE events SET data=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?').run(JSON.stringify(next),time,session.user_id,r.id,r.version);
              if (!update.changes) fail(409,'Someone else updated this event. Reload before publishing.');
              db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)').run(id(),r.id,classId,r.version+1,JSON.stringify(next),JSON.stringify(changed),session.user_id,time);
              const message=changed.map(c=>c.message).join('. ');
              notify(classId,next.subgroup,next.title,message,'change',r.id,session.user_id);
              if (previous.subgroup && previous.subgroup!==next.subgroup) notify(classId,previous.subgroup,next.title,'This event has been reassigned to another subgroup.','change',null,session.user_id);
              updatedIds.push(r.id);
            }
          }); broadcast(classId); return json(res,200,{ok:true,ids:updatedIds});
        }
      }
      if (route==='announcements' && req.method==='POST') {
        editor(); const title=text(body.title,'title',200,true), message=text(body.message,'message',5000,true), subgroup=text(body.subgroup??'','subgroup',250);
        if (!['normal','important','urgent'].includes(body.priority)) fail(400,'Choose an announcement priority.');
        if (body.pinned && m.role!=='admin') fail(403,'Only admins can pin announcements.');
        let expires=null;
        if (body.expires_at) { if (!Number.isFinite(Date.parse(body.expires_at))) fail(400,'Enter a valid expiration date.'); expires=new Date(body.expires_at).toISOString(); if (expires<=now()) fail(400,'Expiration must be in the future.'); }
        const announcementId=id(); transaction(db,()=>{
          db.prepare('INSERT INTO announcements VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(announcementId,classId,title,message,subgroup,body.priority,body.pinned?1:0,expires,1,session.user_id,now());
          notify(classId,subgroup,title,message,'announcement',null,session.user_id);
        }); broadcast(classId); return json(res,201,{id:announcementId});
      }
      const announcementMatch=route.match(/^announcements\/([^/]+)$/);
      if (announcementMatch && req.method==='PATCH') {
        editor(); const a=db.prepare('SELECT * FROM announcements WHERE id=? AND class_id=?').get(announcementMatch[1],classId);
        if (!a) fail(404,'Announcement not found.');
        const title=text(body.title,'title',200,true), message=text(body.message,'message',5000,true), subgroup=text(body.subgroup??'','subgroup',250);
        if (!['normal','important','urgent'].includes(body.priority)) fail(400,'Choose an announcement priority.');
        if (Boolean(body.pinned)!==Boolean(a.pinned) && m.role!=='admin') fail(403,'Only admins can change pinned status.');
        let expires=null; if (body.expires_at) { if (!Number.isFinite(Date.parse(body.expires_at))) fail(400,'Enter a valid expiration.'); expires=new Date(body.expires_at).toISOString(); }
        transaction(db,()=>{
          if (!db.prepare('UPDATE announcements SET title=?,message=?,subgroup=?,priority=?,pinned=?,expires_at=?,version=version+1,updated_at=? WHERE id=? AND class_id=? AND version=?').run(title,message,subgroup,body.priority,body.pinned?1:0,expires,now(),a.id,classId,Number(body.version)).changes) fail(409,'This announcement has changed. Reload before publishing.');
          notify(classId,subgroup,title,message,'announcement',null,session.user_id);
        }); broadcast(classId); return json(res,200,{ok:true});
      }
      const readMatch=route.match(/^notifications\/([^/]+)\/read$/);
      if (readMatch && req.method==='POST') {
        const n=db.prepare('SELECT * FROM notifications WHERE id=? AND class_id=?').get(readMatch[1],classId);
        if (!n || !visible(n.subgroup,m)) fail(404,'Update not found.');
        db.prepare('INSERT OR IGNORE INTO notification_reads VALUES (?,?)').run(n.id,session.user_id); return json(res,200,{ok:true});
      }
      if (route==='notifications/read-all' && req.method==='POST') {
        transaction(db,()=>{ for (const n of db.prepare('SELECT id,subgroup FROM notifications WHERE class_id=?').all(classId).filter(n=>visible(n.subgroup,m))) db.prepare('INSERT OR IGNORE INTO notification_reads VALUES (?,?)').run(n.id,session.user_id); }); return json(res,200,{ok:true});
      }
      if (route==='members' && req.method==='GET') {
        admin(); return json(res,200,db.prepare('SELECT u.id,u.name,u.email,m.role,m.subgroup FROM members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? ORDER BY u.name').all(classId));
      }
      const memberMatch=route.match(/^members\/([^/]+)$/);
      if (memberMatch && ['PATCH','DELETE'].includes(req.method)) {
        admin(); const userId=memberMatch[1], target=member(classId,userId);
        transaction(db,()=>{
          if (target.role==='admin' && (req.method==='DELETE' || body.role!=='admin') && db.prepare("SELECT COUNT(*) AS count FROM members WHERE class_id=? AND role='admin'").get(classId).count<=1) fail(400,'Keep at least one administrator in the class.');
          if (req.method==='DELETE') db.prepare('DELETE FROM members WHERE class_id=? AND user_id=?').run(classId,userId);
          else {
            if (!['admin','editor','student'].includes(body.role)) fail(400,'Choose a valid role.');
            db.prepare('UPDATE members SET role=?,subgroup=? WHERE class_id=? AND user_id=?').run(body.role,text(body.subgroup??'','subgroup',250),classId,userId);
          }
        }); broadcast(classId); return json(res,200,{ok:true});
      }
      if (route==='invitations' && req.method==='GET') {
        admin(); return json(res,200,db.prepare('SELECT id,subgroup,expires_at,revoked,created_at FROM invitations WHERE class_id=? ORDER BY created_at DESC').all(classId));
      }
      if (route==='invitations' && req.method==='POST') {
        admin(); const days=Number(body.days||7); if (!Number.isInteger(days)||days<1||days>90) fail(400,'Invitations last between 1 and 90 days.');
        const code=token(), invitationId=id();
        db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?)').run(invitationId,classId,hash(code),text(body.subgroup??'','subgroup',250),new Date(Date.now()+days*86400000).toISOString(),0,now());
        return json(res,201,{id:invitationId,code});
      }
      const inviteMatch=route.match(/^invitations\/([^/]+)$/);
      if (inviteMatch && req.method==='DELETE') {
        admin(); if (!db.prepare('UPDATE invitations SET revoked=1 WHERE id=? AND class_id=?').run(inviteMatch[1],classId).changes) fail(404,'Invitation not found.'); return json(res,200,{ok:true});
      }
      fail(404,'API route not found.');
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) json(res,error.status||500,{error:error.status?error.message:'Something went wrong. Please try again.'});
      else res.end();
    }
  });
  const heartbeat=setInterval(()=>{
    for (const s of streams) {
      if (!db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires_at>?').get(s.token,Date.now())) { s.res.end(); streams.delete(s); }
      else s.res.write(': heartbeat\n\n');
    }
  },25000); heartbeat.unref();
  server.on('close',()=>{ clearInterval(heartbeat); db.close(); });
  return {server,db,close:async()=>{for(const s of streams)s.res.end(); await new Promise(r=>server.close(r));}};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {server}=createApp();
  server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`MedClass is running at http://${process.env.HOST||'localhost'}:${process.env.PORT||3000}`));
}
