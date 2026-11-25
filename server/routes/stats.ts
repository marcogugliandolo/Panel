import express from 'express';
import type { ContainerInfo, DetectedNpmHost, HistoryRange, MetricPoint, ServerStats } from '../../shared/types';
import { config } from '../config';
import type { DB } from '../db';
import { parseNginxMinute, type TrafficSample } from '../incidents';

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
  ips: string | null;
  npm_hosts: string | null;
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

/** Proxy hosts de NPM que lee el script en el servidor. */
function toNpmHosts(value: unknown[]): DetectedNpmHost[] {
  const hosts: DetectedNpmHost[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const domains = (Array.isArray(r.domains) ? r.domains : [])
      .map((d) => String(d).toLowerCase().trim())
      .filter((d) => /^[a-z0-9*][a-z0-9.*-]{0,252}$/.test(d))
      .slice(0, 50);
    if (!domains.length) continue;
    hosts.push({
      domains,
      host: cleanText(r.host, 200) ?? '',
      port: Number(r.port) > 0 && Number(r.port) < 65536 ? Number(r.port) : 0,
      scheme: r.scheme === 'https' ? 'https' : 'http',
      ssl: r.ssl === true,
      error: r.error === true,
    });
  }
  return hosts;
}

/** IPs que envía el script (IPv4/IPv6 sin más). */
function toIps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(v))
    .slice(0, 32);
}

/** Normaliza la lista de contenedores: admite nombres sueltos (formato antiguo) u objetos con estado. */
/** Lista de palabras («app web» o ["app","web"]) validada; vacía no se guarda. */
function words<K extends string>(key: K, value: unknown, valid: RegExp): Partial<Record<K, string[]>> {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : [];
  const list = [...new Set(raw.map((w) => String(w).trim()).filter((w) => valid.test(w)))].slice(0, 20);
  return list.length ? ({ [key]: list } as Partial<Record<K, string[]>>) : {};
}

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
        ports: cleanText(record.ports ?? record.Ports, 400),
        ...words('aliases', record.aliases, /^[a-z0-9][a-z0-9_.-]{0,127}$/i),
        ...words('ips', record.ips, /^\d{1,3}(\.\d{1,3}){3}$/),
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
    ips: parseJson<string[]>(row.ips, []),
    npmHosts: parseJson<DetectedNpmHost[] | null>(row.npm_hosts, null),
    lastUpdated: row.last_updated,
    online: now - row.last_updated <= config.offlineAfterMs,
  };
}

/** POST /api/stats/:id — lo usan los scripts de cada servidor (protegido con STATS_TOKEN, no con sesión). */
/** Visitas por dominio y minuto que el script lee de los logs de Nginx Proxy Manager. */
function toTraffic(value: unknown): TrafficSample[] {
  if (!Array.isArray(value)) return [];
  const out: TrafficSample[] = [];
  for (const raw of value.slice(0, 5000)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const host = String(r.host ?? '').toLowerCase();
    const minute = parseNginxMinute(String(r.m ?? ''));
    const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(1_000_000, Math.round(Number(v))) : 0);
    if (!/^[a-z0-9.-]{1,253}$/.test(host) || minute === null) continue;
    out.push({ host, minute, requests: n(r.n), failed: n(r.e5), gateway: n(r.gw) });
  }
  return out;
}

export function createIngestHandler(db: DB, onTraffic?: (samples: TrafficSample[]) => void): express.RequestHandler {
  const lastMetricAt = new Map<string, number>();

  const upsert = db.prepare(`
    INSERT INTO server_stats (server_id, cpu_usage, ram_usage, disk_usage, uptime_seconds, hostname,
                              apps_total, apps_running, container_list, containers, ips, npm_hosts, last_updated)
    VALUES (@serverId, @cpu, @ram, @disk, @uptime, @hostname, @appsTotal, @appsRunning, @containerList, @containers, @ips, @npmHosts, @now)
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
      ips = excluded.ips,
      npm_hosts = excluded.npm_hosts,
      last_updated = excluded.last_updated
  `);
  const insertMetric = db.prepare('INSERT INTO metrics (server_id, ts, cpu, ram, disk) VALUES (?, ?, ?, ?, ?)');
  const rememberIps = createIpMemory(db);

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
      ips: JSON.stringify(toIps(body.ips)),
      npmHosts: Array.isArray(body.npm) ? JSON.stringify(toNpmHosts(body.npm)) : null,
      now,
    });

    rememberIps(serverId, containers, now);

    if (now - (lastMetricAt.get(serverId) ?? 0) >= METRIC_INTERVAL_MS) {
      insertMetric.run(serverId, now, cpu, ram, disk);
      lastMetricAt.set(serverId, now);
    }

    if (onTraffic && Array.isArray(body.npmTraffic)) onTraffic(toTraffic(body.npmTraffic));
    res.json({ success: true });
  };
}

/**
 * Docker le quita la IP a un contenedor al pararlo. Si Nginx Proxy Manager apunta a esa IP
 * (172.21.0.5:3000), el panel tiene que seguir sabiendo de quién era justo cuando la web se cae:
 * se guarda la última IP de cada contenedor en marcha.
 */
function ensureIpTable(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS container_ips (
    server_id TEXT NOT NULL, ip TEXT NOT NULL, container TEXT NOT NULL, seen_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, ip))`);
}
export function createIpMemory(db: DB) {
  ensureIpTable(db);
  const put = db.prepare(
    `INSERT INTO container_ips (server_id, ip, container, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, ip) DO UPDATE SET container = excluded.container, seen_at = excluded.seen_at`,
  );
  const prune = db.prepare('DELETE FROM container_ips WHERE seen_at < ?');
  const written = new Map<string, { container: string; at: number }>();
  let prunedAt = 0;
  return (serverId: string, containers: ContainerInfo[], now: number) => {
    for (const c of containers) {
      if (c.state !== 'running') continue;
      for (const ip of c.ips ?? []) {
        const key = `${serverId}|${ip}`;
        const last = written.get(key);
        // Se escribe al cambiar y, si no, una vez al día (para saber que sigue siendo suya).
        if (last && last.container === c.name && now - last.at < 86_400_000) continue;
        put.run(serverId, ip, c.name, now);
        written.set(key, { container: c.name, at: now });
      }
    }
    if (now - prunedAt > 86_400_000) {
      prune.run(now - 60 * 86_400_000);
      prunedAt = now;
    }
  };
}
/** El contenedor que tuvo esa IP la última vez que se vio en marcha. */
export function containerForIp(db: DB, serverId: string, ip: string): string | null {
  ensureIpTable(db);
  const row = db.prepare('SELECT container FROM container_ips WHERE server_id = ? AND ip = ?').get(serverId, ip) as { container: string } | undefined;
  return row?.container ?? null;
}

/** Métricas de todos los servidores tal como las ve la interfaz (también las usa el aviso por Telegram). */
export function readAllStats(db: DB, now = Date.now()): ServerStats[] {
  const rows = db.prepare('SELECT * FROM server_stats ORDER BY server_id').all() as StatsRow[];
  return rows.map((row) => rowToStats(row, now));
}

/** Rutas de lectura para la interfaz (requieren sesión). */
export function createStatsRouter(db: DB) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(readAllStats(db));
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
