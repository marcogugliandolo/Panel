import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export type DB = Database.Database;

export function openDatabase(): DB {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(path.join(config.dataDir, 'database.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((c) => c.name === column);
}

function addColumn(db: DB, table: string, column: string, type: string) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function migrate(db: DB) {
  // Tablas de la versión anterior: se conservan tal cual para no perder datos.
  db.exec(`
    CREATE TABLE IF NOT EXISTS layout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodes TEXT,
      zones TEXT
    );
    CREATE TABLE IF NOT EXISTS server_stats (
      server_id TEXT PRIMARY KEY,
      cpu_usage REAL,
      ram_usage REAL,
      apps_total INTEGER,
      apps_running INTEGER,
      container_list TEXT,
      last_updated INTEGER
    );
  `);

  addColumn(db, 'layout', 'wires', 'TEXT');
  addColumn(db, 'layout', 'saved_at', 'INTEGER');
  addColumn(db, 'server_stats', 'container_list', 'TEXT');
  addColumn(db, 'server_stats', 'disk_usage', 'REAL');
  addColumn(db, 'server_stats', 'uptime_seconds', 'INTEGER');
  addColumn(db, 'server_stats', 'hostname', 'TEXT');
  addColumn(db, 'server_stats', 'containers', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      server_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      cpu REAL,
      ram REAL,
      disk REAL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON metrics (server_id, ts);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      interval_sec INTEGER NOT NULL DEFAULT 60,
      timeout_ms INTEGER NOT NULL DEFAULT 10000,
      keyword TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      cert_expires_at INTEGER,
      cert_issuer TEXT,
      cert_error TEXT,
      cert_checked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS monitor_checks (
      monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      status_code INTEGER,
      latency_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON monitor_checks (monitor_id, ts);
  `);
}

/** Borra historial antiguo. Se llama cada hora. */
export function pruneHistory(db: DB) {
  const cutoff = Date.now() - config.historyDays * 86_400_000;
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM monitor_checks WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  // El diseño se guarda como versiones; se conservan las 20 últimas.
  db.prepare('DELETE FROM layout WHERE id NOT IN (SELECT id FROM layout ORDER BY id DESC LIMIT 20)').run();
}
