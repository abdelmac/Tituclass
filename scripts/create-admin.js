import { openDatabase, transaction } from '../lib/db.js';
import { credentials, text, id, now, passwordHash } from '../lib/auth.js';
const db=openDatabase();
try {
  const {email,password}=credentials({email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});
  const name=text(process.env.ADMIN_NAME||'Class administrator','name',100,true);
  const className=text(process.env.CLASS_NAME||'Medicine · Class of 2028','class name',100,true);
  const timezone=process.env.CLASS_TIMEZONE||'Europe/Paris'; new Intl.DateTimeFormat('en',{timeZone:timezone});
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw Error('Account already exists. Use the existing admin to manage roles.');
  const userId=id(), classId=id(), passwordValue=await passwordHash(password);
  transaction(db,()=>{
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(userId,name,email,passwordValue,now());
    db.prepare('INSERT INTO classes(id,name,timezone) VALUES (?,?,?)').run(classId,className,timezone);
    db.prepare('INSERT INTO members(class_id,user_id,role) VALUES (?,?,?)').run(classId,userId,'admin');
  });
  console.log(`Administrator created for ${className}. Sign in with your configured email and password. Remove ADMIN_PASSWORD from .env after bootstrap.`);
} catch(error) { console.error(error.message); process.exitCode=1; } finally {db.close();}
