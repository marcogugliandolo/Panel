import express from 'express';
import type { ContainerInfo, HistoryRange, MetricPoint, ServerStats } from '../../shared/types';
import { config } from '../config';
import type { DB } from '../db';

const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const METRIC_INTERVAL_MS = 55_000; // como mucho un punto de historial por minuto y servidor

export const HISTORY_RANGES: Record<HistoryRange, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

interface StatsRow {
  server_id: string;
  cpu_usage: number | null;
  ram_usage: number | null;
  disk_usage: number | null;
  uptime_seconds: number | null;
  hostname: string | null;
  apps_total: number | null;
  apps_running: number | null;
  container_list: string | null;
  containers: string | null;
  last_updated: number;
}

function toPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.min(100, Math.max(0, parsed));
}

function toCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

/** Acepta segundos (número o texto numérico) o el formato de `uptime -p` ("up 3 days, 4 hours"). */
function toUptimeSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text));
  const units: Record<string, number> = { week: 604_800, day: 86_400, hour: 3_600, minute: 60 };
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of text.matchAll(/(\d+)\s*(week|day|hour|minute)s?/gi)) {
    total += Number(amount) * units[unit.toLowerCase()];
    matched = true;
  }
  return matched ? total : null;
}

function cleanText(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Docker antiguos no tienen {{.State}} en `docker ps --format`: se deduce del texto de estado. */
function stateFromStatus(status: string | null): string {
  if (!status) return 'unknown';
  const text = status.toLowerCase();
  if (text.includes('(paused)')) return 'paused';
  if (text.startsWith('up')) return 'running';
  if (text.startsWith('restarting')) return 'restarting';
  if (text.startsWith('exited')) return 'exited';
  if (text.startsWith('created')) return 'created';
  if (text.startsWith('dead')) return 'dead';
  if (text.startsWith('removal')) return 'removing';
  return 'unknown';
}

/** Normaliza la lista de contenedores: admite nombres sueltos (formato antiguo) u objetos con estado. */
function toContainers(value: unknown): ContainerInfo[] | null {
  if (!Array.isArray(value)) return null;
  const result: ContainerInfo[] = [];
  for (const item of value.slice(0, 500)) {
    if (typeof item === 'string') {
      const name = cleanText(item.replace(/^\//, ''), 200);
      if (name) result.push({ name, state: 'unknown' });
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const name = cleanText(String(record.name ?? record.Names ?? '').replace(/^\//, ''), 200);
      if (!name) continue;
      const status = cleanText(record.status ?? record.Status, 120);
      const state = (cleanText(record.state ?? record.State, 30) || '').toLowerCase();
      result.push({
        name,
        state: state && state !== 'unknown' ? state : stateFromStatus(status),
        status,
        image: cleanText(record.image ?? record.Image, 200),
      });
    }
  }
  return result;
}

/**
 * El script antiguo manda solo los nombres de `docker ps` (los que están en marcha).
 * Si la cuenta coincide con appsRunning, se marcan como en marcha.
 */
function markLegacyRunning(containers: ContainerInfo[], appsRunning: number | null): ContainerInfo[] {
  const allUnknown = containers.length > 0 && containers.every((c) => c.state === 'unknown');
  if (allUnknown && appsRunning === containers.length) {
    return containers.map((c) => ({ ...c, state: 'running' }));
  }
  return containers;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToStats(row: StatsRow, now: number): ServerStats {
  let containers = parseJson<ContainerInfo[] | null>(row.containers, null);
  if (!Array.isArray(containers)) {
    const names = parseJson<unknown>(row.container_list, []);
    containers = markLegacyRunning(toContainers(names) ?? [], row.apps_running);
  }
  return {
    serverId: row.server_id,
    hostname: row.hostname,
    cpu: row.cpu_usage,
    ram: row.ram_usage,
    disk: row.disk_usage,
    uptimeSeconds: row.uptime_seconds,
    appsTotal: row.apps_total,
    appsRunning: row.apps_running,
    containers,
    lastUpdated: row.last_updated,
    online: now - row.last_updated <= config.offlineAfterMs,
  };
}

/** POST /api/stats/:id — lo usan los scripts de cada servidor (protegido con STATS_TOKEN, no con sesión). */
export function createIngestHandler(db: DB): express.RequestHandler {
  const lastMetricAt = new Map<string, number>();

  const upsert = db.prepare(`
    INSERT INTO server_stats (server_id, cpu_usage, ram_usage, disk_usage, uptime_seconds, hostname,
                              apps_total, apps_running, container_list, containers, last_updated)
    VALUES (@serverId, @cpu, @ram, @disk, @uptime, @hostname, @appsTotal, @appsRunning, @containerList, @containers, @now)
    ON CONFLICT (server_id) DO UPDATE SET
      cpu_usage = excluded.cpu_usage,
      ram_usage = excluded.ram_usage,
      disk_usage = excluded.disk_usage,
      uptime_seconds = excluded.uptime_seconds,
      hostname = excluded.hostname,
      apps_total = excluded.apps_total,
      apps_running = excluded.apps_running,
      container_list = excluded.container_list,
      containers = excluded.containers,
      last_updated = excluded.last_updated
  `);
  const insertMetric = db.prepare('INSERT INTO metrics (server_id, ts, cpu, ram, disk) VALUES (?, ?, ?, ?, ?)');

  return (req, res) => {
    const serverId = req.params.id;
    if (!SERVER_ID.test(serverId)) {
      res.status(400).json({ error: 'Id de servidor no válido' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const now = Date.now();

    const cpu = toPercent(body.cpu ?? body.cpu_usage);
    const ram = toPercent(body.ram ?? body.ram_usage ?? body.memory);
    const disk = toPercent(body.disk ?? body.disk_usage);
    const reported =
      toContainers(body.containers) ?? toContainers(body.containerList) ?? toContainers(body.container_list) ?? [];
    const reportedTotal = toCount(body.appsTotal ?? body.apps_total);
    const reportedRunning = toCount(body.appsRunning ?? body.apps_running);

    // Con estados (script nuevo) los totales salen de la lista; con solo nombres (script antiguo), de lo que manda.
    const hasStates = reported.some((c) => c.state !== 'unknown');
    const containers = hasStates ? reported : markLegacyRunning(reported, reportedRunning);
    const appsTotal = hasStates ? reported.length : reportedTotal;
    const appsRunning = hasStates ? reported.filter((c) => c.state === 'running').length : reportedRunning;

    upsert.run({
      serverId,
      cpu,
      ram,
      disk,
      uptime: toUptimeSeconds(body.uptime ?? body.uptimeSeconds ?? body.uptime_seconds),
      hostname: cleanText(body.hostname, 120),
      appsTotal,
      appsRunning,
      containerList: JSON.stringify(containers.map((c) => c.name)),
      containers: JSON.stringify(containers),
      now,
    });

    if (now - (lastMetricAt.get(serverId) ?? 0) >= METRIC_INTERVAL_MS) {
      insertMetric.run(serverId, now, cpu, ram, disk);
      lastMetricAt.set(serverId, now);
    }

    res.json({ success: true });
  };
}

/** Rutas de lectura para la interfaz (requieren sesión). */
export function createStatsRouter(db: DB) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM server_stats ORDER BY server_id').all() as StatsRow[];
    res.json(rows.map((row) => rowToStats(row, now)));
  });

  router.get('/:id/history', (req, res) => {
    const range = (req.query.range as HistoryRange) in HISTORY_RANGES ? (req.query.range as HistoryRange) : '24h';
    const span = HISTORY_RANGES[range];
    const bucket = Math.max(60_000, Math.floor(span / 120));
    const since = Date.now() - span;
    const points = db
      .prepare(
        `SELECT CAST(ts / @bucket AS INTEGER) * @bucket AS t,
                ROUND(AVG(cpu), 1) AS cpu, ROUND(AVG(ram), 1) AS ram, ROUND(AVG(disk), 1) AS disk,
                ROUND(MAX(cpu), 1) AS cpuMax
         FROM metrics
         WHERE server_id = @serverId AND ts >= @since
         GROUP BY t
         ORDER BY t`,
      )
      .all({ bucket, since, serverId: req.params.id }) as MetricPoint[];
    res.json({ range, bucketMs: bucket, points });
  });

  /** Olvida un servidor (por ejemplo, uno que ya no existe). */
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM server_stats WHERE server_id = ?').run(req.params.id);
    db.prepare('DELETE FROM metrics WHERE server_id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
}
