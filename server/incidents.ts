/*
 * Cortes de las webs y tráfico real.
 *
 * Cortes: un corte empieza con dos comprobaciones fallidas seguidas (la primera marca el inicio) y termina con la
 * siguiente que responde bien. Durante el corte se guarda la causa que encuentra el diagnóstico de la ruta, así que
 * después se sigue sabiendo por qué se cayó aunque ya funcione.
 *
 * Tráfico: el script de métricas lee los access logs de Nginx Proxy Manager y manda, por dominio y minuto, cuántas
 * visitas hubo y cuántas fallaron. Se guarda 30 días.
 */
import type { Diagnosis, RouteStepId, WebIncident, WebTraffic, WebTrafficPoint } from '../shared/types';
import type { DB } from './db';

const INCIDENT_DAYS = 90;
const TRAFFIC_DAYS = 30;

interface IncidentRow {
  id: number;
  monitor_id: number;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  cause_title: string | null;
  cause_summary: string | null;
  failed_at: string | null;
}

export interface TrafficSample {
  host: string;
  minute: number;
  requests: number;
  failed: number;
  gateway: number;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** «25/Nov/2026:10:15 +0000» (hora de nginx) → milisegundos del inicio de ese minuto. */
export function parseNginxMinute(text: string): number | null {
  const m = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(text.trim());
  if (!m || MONTHS[m[2]] === undefined) return null;
  const utc = Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]), Number(m[4]), Number(m[5]));
  const offset = m[6] ? (m[6] === '-' ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60_000 : 0;
  return utc - offset;
}

export function createWebHistory(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      error TEXT,
      cause_title TEXT,
      cause_summary TEXT,
      failed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON monitor_incidents (monitor_id, started_at);
    CREATE TABLE IF NOT EXISTS web_traffic (
      host TEXT NOT NULL,
      minute INTEGER NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      gateway INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (host, minute)
    );
  `);

  const openIncident = (monitorId: number) =>
    db.prepare('SELECT * FROM monitor_incidents WHERE monitor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(monitorId) as
      | IncidentRow
      | undefined;

  /** Primera vez: se reconstruyen los cortes del historial de comprobaciones que ya había (sin causa). */
  function backfill() {
    const { done } = (db.prepare("SELECT COUNT(*) AS done FROM settings WHERE key = 'incidents_backfilled'").get() as { done: number }) ?? { done: 0 };
    if (done) return;
    const monitors = db.prepare('SELECT id FROM monitors').all() as { id: number }[];
    const insert = db.prepare('INSERT INTO monitor_incidents (monitor_id, started_at, ended_at, error) VALUES (?, ?, ?, ?)');
    let total = 0;
    db.transaction(() => {
      for (const { id } of monitors) {
        const checks = db.prepare('SELECT ts, ok, error FROM monitor_checks WHERE monitor_id = ? ORDER BY ts').all(id) as { ts: number; ok: number; error: string | null }[];
        let streak: { start: number; count: number; error: string | null } | null = null;
        for (const c of checks) {
          if (!c.ok) {
            if (streak) {
              streak.count += 1;
              streak.error = c.error;
            } else streak = { start: c.ts, count: 1, error: c.error };
            continue;
          }
          if (streak && streak.count >= 2) {
            insert.run(id, streak.start, c.ts, streak.error);
            total += 1;
          }
          streak = null;
        }
        if (streak && streak.count >= 2) {
          insert.run(id, streak.start, null, streak.error);
          total += 1;
        }
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('incidents_backfilled', '1') ON CONFLICT(key) DO NOTHING").run();
    })();
    if (total) console.log(`[webs] Reconstruidos ${total} cortes del historial de comprobaciones`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  backfill();

  /** Tras cada comprobación: abre o cierra el corte. */
  function recordCheck(monitorId: number, ts: number, ok: boolean, error: string | null) {
    const open = openIncident(monitorId);
    if (ok) {
      if (open) db.prepare('UPDATE monitor_incidents SET ended_at = ? WHERE id = ?').run(ts, open.id);
      return;
    }
    if (open) {
      db.prepare('UPDATE monitor_incidents SET error = ? WHERE id = ?').run(error, open.id);
      return;
    }
    // Dos fallos seguidos: el corte empieza en el primero.
    const last2 = db.prepare('SELECT ts, ok FROM monitor_checks WHERE monitor_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 2').all(monitorId, ts) as { ts: number; ok: number }[];
    if (last2.length === 2 && last2.every((c) => !c.ok)) {
      db.prepare('INSERT INTO monitor_incidents (monitor_id, started_at, error) VALUES (?, ?, ?)').run(monitorId, last2[1].ts, error);
    }
  }

  /** La causa del corte es la primera que encuentra el diagnóstico (la que lo provocó). */
  function recordDiagnosis(monitorId: number, diagnosis: Diagnosis) {
    if (diagnosis.ok) return;
    const open = openIncident(monitorId);
    if (!open || open.cause_title) return;
    db.prepare('UPDATE monitor_incidents SET cause_title = ?, cause_summary = ?, failed_at = ? WHERE id = ?').run(
      diagnosis.title,
      diagnosis.summary,
      diagnosis.failedAt,
      open.id,
    );
  }

  function forgetMonitor(monitorId: number) {
    db.prepare('DELETE FROM monitor_incidents WHERE monitor_id = ?').run(monitorId);
  }

  function failedVisits(host: string | null, from: number, to: number): number | null {
    if (!host) return null;
    const row = db.prepare('SELECT SUM(failed) AS failed, COUNT(*) AS n FROM web_traffic WHERE host = ? AND minute >= ? AND minute <= ?').get(host, from - 60_000, to) as {
      failed: number | null;
      n: number;
    };
    return row.n ? (row.failed ?? 0) : null;
  }

  function incidents(monitorId: number, since: number, host: string | null): WebIncident[] {
    const rows = db
      .prepare('SELECT * FROM monitor_incidents WHERE monitor_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 200')
      .all(monitorId, since) as IncidentRow[];
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: (r.ended_at ?? now) - r.started_at,
      error: r.error,
      cause: r.cause_title ? { title: r.cause_title, summary: r.cause_summary ?? '', failedAt: (r.failed_at as RouteStepId | null) ?? null } : null,
      failedVisits: failedVisits(host, r.started_at, r.ended_at ?? now),
    }));
  }

  /* --- Tráfico real (logs de NPM) --- */
  const upsertTraffic = db.prepare(
    `INSERT INTO web_traffic (host, minute, requests, failed, gateway) VALUES (@host, @minute, @requests, @failed, @gateway)
     ON CONFLICT(host, minute) DO UPDATE SET requests = requests + excluded.requests, failed = failed + excluded.failed, gateway = gateway + excluded.gateway`,
  );
  function addTraffic(samples: TrafficSample[]) {
    if (!samples.length) return;
    db.transaction(() => {
      for (const s of samples) upsertTraffic.run(s);
    })();
  }

  function traffic(host: string, since: number, bucketMs: number): WebTraffic {
    const points = db
      .prepare(
        `SELECT CAST(minute / @bucket AS INTEGER) * @bucket AS t, SUM(requests) AS requests, SUM(failed) AS failed, SUM(gateway) AS gateway
         FROM web_traffic WHERE host = @host AND minute >= @since GROUP BY t ORDER BY t`,
      )
      .all({ bucket: bucketMs, host, since }) as WebTrafficPoint[];
    const totals = points.reduce((acc, p) => ({ requests: acc.requests + p.requests, failed: acc.failed + p.failed, gateway: acc.gateway + p.gateway }), {
      requests: 0,
      failed: 0,
      gateway: 0,
    });
    const last = db.prepare('SELECT MAX(minute) AS last FROM web_traffic WHERE host = ?').get(host) as { last: number | null };
    return { bucketMs, points, totals, lastAt: last.last };
  }

  function prune() {
    db.prepare('DELETE FROM monitor_incidents WHERE ended_at IS NOT NULL AND ended_at < ?').run(Date.now() - INCIDENT_DAYS * 86_400_000);
    db.prepare('DELETE FROM web_traffic WHERE minute < ?').run(Date.now() - TRAFFIC_DAYS * 86_400_000);
  }

  return { recordCheck, recordDiagnosis, forgetMonitor, incidents, addTraffic, traffic, prune };
}

export type WebHistoryStore = ReturnType<typeof createWebHistory>;
