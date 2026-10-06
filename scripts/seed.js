import { openDatabase, transaction } from '../lib/db.js';
import { id, now, hash, passwordHash } from '../lib/auth.js';
import { validateEvent, changes } from '../lib/events.js';
const db=openDatabase();
try {
  if (db.prepare("SELECT 1 FROM classes WHERE id='demo-medicine'").get()) throw Error('Demo already exists. Use npm run remove-demo before reseeding.');
  const users=[['demo-admin','Alex Morgan','admin@medclass.demo'],['demo-editor','Sam Taylor','editor@medclass.demo'],['demo-student','Jamie Chen','student@medclass.demo'],['demo-other','Robin Lane','other@medclass.demo']];
  const password=await passwordHash('MedClassDemo2026!');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date=offset=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
  transaction(db,()=>{
    for(const [uid,name,email] of users) db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(uid,name,email,password,now());
    db.prepare('INSERT INTO classes VALUES (?,?,?,?)').run('demo-medicine','Medicine · Class of 2028','Europe/Paris',1);
    db.prepare('INSERT INTO classes VALUES (?,?,?,?)').run('demo-dentistry','Dentistry · Class of 2029','Europe/Paris',1);
    for(const [uid,role] of [['demo-admin','admin'],['demo-editor','editor'],['demo-student','student']]) db.prepare('INSERT INTO members(class_id,user_id,role,subgroup) VALUES (?,?,?,?)').run('demo-medicine',uid,role,'Group A');
    db.prepare('INSERT INTO members(class_id,user_id,role) VALUES (?,?,?)').run('demo-dentistry','demo-other','student');
    const add=(classId,raw,old)=>{
      const eventId=id(),data=validateEvent(raw),time=now();
      db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(eventId,classId,null,JSON.stringify(data),old?2:1,time,'demo-admin');
      db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)').run(id(),eventId,classId,1,JSON.stringify(old?validateEvent({...data,...old}):data),'[]','demo-admin',time);
      if(old){ const changed=changes(validateEvent({...data,...old}),data);
        db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)').run(id(),eventId,classId,2,JSON.stringify(data),JSON.stringify(changed),'demo-admin',time);
        db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)').run(id(),classId,data.subgroup,data.title,changed.map(c=>c.message).join('. '),'change',eventId,'demo-admin',time);
      }
    };
    add('demo-medicine',{title:'Cardiovascular physiology',subject:'Physiology',type:'lecture',date:today,start:'09:00',end:'10:30',building:'Medical Sciences Building',room:'B04',instructor:'Dr. Emma Laurent',attendance:'required',notes:'Bring your lecture notes. Enter through the east entrance.'},{room:'A12'});
    add('demo-medicine',{title:'Anatomy dissection lab',subject:'Anatomy',type:'practical',date:today,start:'11:00',end:'13:00',building:'Anatomy Centre',room:'Lab 03',instructor:'Prof. Daniel Reed',attendance:'required',subgroup:'Group A',notes:'Lab coat and closed-toe shoes are required. Bring your student ID.'});
    add('demo-medicine',{title:'Clinical case discussion',subject:'Clinical medicine',type:'tutorial',date:today,start:'14:00',end:'15:30',building:'Medical Sciences Building',room:'C16',attendance:'not_required',notes:'Optional review session. Cases will be shared after class.'});
    add('demo-medicine',{title:'Histology seminar',subject:'Histology',type:'lecture',date:date(1),start:'10:00',end:'11:00',room:'A08',attendance:'unknown',status:'cancelled',notes:'Instructor unavailable. A replacement date will be announced.'});
    add('demo-medicine',{title:'Pharmacology foundations',subject:'Pharmacology',type:'lecture',date:date(1),start:'13:00',end:'14:30',attendance:'unknown',notes:'Room and attendance requirement are to be confirmed.'});
    add('demo-medicine',{title:'Physiology midterm',subject:'Physiology',type:'exam',date:date(7),start:'09:00',end:'11:00',building:'Assessment Centre',room:'Hall 2',attendance:'required',status:'rescheduled',notes:'Arrive 20 minutes early. Bring student ID and a non-programmable calculator.'},{date:date(5),start:'10:00',end:'12:00',status:'scheduled'});
    add('demo-medicine',{title:'Anatomy practical assessment',subject:'Anatomy',type:'exam',date:date(14),start:'10:00',end:'11:30',building:'Anatomy Centre',room:'Lab 01',attendance:'required',notes:'Station-based assessment. Lab coat required.'});
    add('demo-medicine',{title:'Biochemistry final',subject:'Biochemistry',type:'exam',date:date(21),attendance:'unknown',notes:'Time, room, and attendance details will be confirmed by the faculty.'});
    add('demo-medicine',{title:'Clinical placement briefing',subject:'Clinical medicine',type:'other',attendance:'unknown',notes:'Date and venue to be confirmed.'});
    add('demo-dentistry',{title:'Private dentistry lecture',subject:'Dentistry',type:'lecture',date:today,attendance:'required'});
    for(const [title,message,priority,pinned] of [
      ['A new room for physiology','Today’s 09:00 physiology lecture has moved from A12 to B04 in the Medical Sciences Building. Please let your classmates know.','urgent',1],
      ['Your midterm, a little later','The physiology midterm has been rescheduled. Check the Exams page for the confirmed date and instructions.','important',0],
      ['Welcome to your class space','One place for your schedule, exam details, and the updates that matter. This is a demonstration class with sample information.','normal',0]
    ]) {
      db.prepare('INSERT INTO announcements VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id(),'demo-medicine',title,message,'',priority,pinned,null,1,'demo-admin',now());
      db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?)').run(id(),'demo-medicine','',title,message,'announcement',null,'demo-admin',now());
    }
    db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?)').run(id(),'demo-medicine',hash('MEDCLASS-DEMO'),'Group A',new Date(Date.now()+30*86400000).toISOString(),0,now());
  });
  console.log('Demo seeded. Admin: admin@medclass.demo; editor: editor@medclass.demo; student: student@medclass.demo. Password: MedClassDemo2026! Invitation: MEDCLASS-DEMO. Remove demo before production.');
} catch(error){console.error(error.message);process.exitCode=1;}finally{db.close();}
