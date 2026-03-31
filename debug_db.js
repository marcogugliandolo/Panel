const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(process.cwd(), 'data', 'database.sqlite'));
const stats = db.prepare('SELECT * FROM server_stats').all();
console.log(JSON.stringify(stats, null, 2));
