import Database from 'better-sqlite3';

function test() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE test (id INTEGER)');
  console.log('SQLite works');
}
test();
