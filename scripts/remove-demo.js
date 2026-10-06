import { openDatabase, transaction } from '../lib/db.js';
const db=openDatabase();
try {
  transaction(db,()=>{
    // Demo users may have joined real classes or created real content: preserve those accounts.
    db.prepare('DELETE FROM classes WHERE demo=1').run();
    for(const uid of ['demo-admin','demo-editor','demo-student','demo-other']) {
      if (!db.prepare('SELECT 1 FROM members WHERE user_id=?').get(uid) && !db.prepare('SELECT 1 FROM events WHERE updated_by=?').get(uid) && !db.prepare('SELECT 1 FROM history WHERE author_id=?').get(uid) && !db.prepare('SELECT 1 FROM announcements WHERE author_id=?').get(uid) && !db.prepare('SELECT 1 FROM notifications WHERE author_id=?').get(uid)) db.prepare('DELETE FROM users WHERE id=?').run(uid);
    }
  }); console.log('Demonstration classes removed. Accounts with non-demo memberships/content were preserved.');
}finally{db.close();}
