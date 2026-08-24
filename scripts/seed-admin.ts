import { DatabaseSync } from 'node:sqlite';

const phone = process.argv[2];
if (!phone) {
  console.error('Usage: tsx scripts/seed-admin.ts <phone>');
  process.exit(1);
}

const dbPath = process.env.DB_PATH || 'data/messenger.dev.db';
const db = new DatabaseSync(dbPath);
db.exec(`INSERT OR IGNORE INTO users(phone,username,first_name,last_name,is_admin) VALUES('${phone}','admin','Admin','User',1)`);
const u = db.prepare('SELECT id,phone,username,is_admin FROM users WHERE phone=?').get(phone);
console.log(JSON.stringify(u));
