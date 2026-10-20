import express from 'express';
import net from 'node:net';
import tls from 'node:tls';
import type {
  HistoryRange,
  Monitor,
  MonitorCheck,
  MonitorHistoryPoint,
  MonitorInput,
  MonitorStatus,
} from '../shared/types';
import type { DB } from './db';
import { HISTORY_RANGES } from './routes/stats';

const TICK_MS = 10_000;
const CERT_REFRESH_MS = 12 * 3_600_000;
const MAX_CONCURRENT = 6;
const USER_AGENT = 'ServerPanel-Monitor/2.0 (+uptime check)';

interface MonitorRow {
  id: number;
  name: string;
  url: string;
  interval_sec: number;
  timeout_ms: number;
  keyword: string | null;
  enabled: number;
  created_at: number;
  cert_expires_at: number | null;
  cert_issuer: string | null;
  cert_error: string | null;
  cert_checked_at: number | null;
}

interface CheckRow {
  ts: number;
  ok: number;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

const NETWORK_ERRORS: Record<string, string> = {
  ENOTFOUND: 'El dominio no existe o no resuelve (DNS)',
  EAI_AGAIN: 'Fallo temporal de DNS',
  ECONNREFUSED: 'Conexión rechazada',
  ECONNRESET: 'La conexión se cortó',
  EHOSTUNREACH: 'Host inalcanzable',
  ENETUNREACH: 'Red inalcanzable',
  CERT_HAS_EXPIRED: 'El certificado SSL ha caducado',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Certificado SSL autofirmado',
  SELF_SIGNED_CERT_IN_CHAIN: 'Certificado SSL autofirmado en la cadena',
  ERR_TLS_CERT_ALTNAME_INVALID: 'El certificado SSL no corresponde a este dominio',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'No se puede verificar el certificado SSL',
};

function describeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `Sin respuesta en ${Math.round(timeoutMs / 1000)} s`;
  }
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  if (cause?.code && NETWORK_ERRORS[cause.code]) return NETWORK_ERRORS[cause.code];
  if (cause?.code) return `Error de red (${cause.code})`;
  return error instanceof Error ? error.message.slice(0, 200) : 'Error desconocido';
}

function checkCertificate(url: URL): Promise<{ expiresAt: number | null; issuer: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port) || 443;
    const socket = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: 10_000,
    });
    const finish = (value: { expiresAt: number | null; issuer: string | null; error: string | null }) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const expiresAt = cert?.valid_to ? Date.parse(cert.valid_to) : null;
      const issuer = (cert?.issuer?.O || cert?.issuer?.CN || null) as string | null;
      const error = socket.authorized ? null : String(socket.authorizationError ?? 'Certificado no válido');
      finish({ expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, issuer, error });
    });
    socket.once('timeout', () => finish({ expiresAt: null, issuer: null, error: 'Sin respuesta al comprobar el certificado' }));
    socket.once('error', (error) => finish({ expiresAt: null, issuer: null, error: error.message }));
  });
}

function validateInput(body: any, partial = false): { value?: Partial<MonitorInput>; error?: string } {
  const value: Partial<MonitorInput> = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return { error: 'El nombre es obligatorio (máximo 80 caracteres)' };
    value.name = name;
  }
  if (!partial || body.url !== undefined) {
    let url: URL;
    try {
      url = new URL(String(body.url ?? '').trim());
    } catch {
      return { error: 'La URL no es válida' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'La URL debe empezar por http:// o https://' };
    value.url = url.toString();
  }
  if (body.intervalSec !== undefined) {
    const interval = Number(body.intervalSec);
    if (!Number.isInteger(interval) || interval < 30 || interval > 3600) return { error: 'El intervalo debe estar entre 30 y 3600 segundos' };
    value.intervalSec = interval;
  }
  if (body.timeoutMs !== undefined) {
    const timeout = Number(body.timeoutMs);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30_000) return { error: 'El tiempo de espera debe estar entre 1 y 30 segundos' };
    value.timeoutMs = timeout;
  }
  if (body.keyword !== undefined) {
    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    if (keyword.length > 200) return { error: 'El texto a buscar es demasiado largo' };
    value.keyword = keyword || null;
  }
  if (body.enabled !== undefined) value.enabled = Boolean(body.enabled);
  return { value };
}

export function createMonitorService(db: DB) {
  const running = new Set<number>();
  const lastRun = new Map<number, number>();

  const insertCheck = db.prepare(
    'INSERT INTO monitor_checks (monitor_id, ts, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const updateCert = db.prepare(
    'UPDATE monitors SET cert_expires_at = ?, cert_issuer = ?, cert_error = ?, cert_checked_at = ? WHERE id = ?',
  );

  async function runCheck(monitor: MonitorRow): Promise<void> {
    const started = performance.now();
    const ts = Date.now();
    let ok = false;
    let statusCode: number | null = null;
    let latency: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetch(monitor.url, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(monitor.timeout_ms),
      });
      latency = Math.round(performance.now() - started);
      statusCode = response.status;
      ok = response.status >= 200 && response.status < 400;
      if (!ok) error = `Respuesta HTTP ${response.status}`;
      if (ok && monitor.keyword) {
        const body = await response.text();
        if (!body.includes(monitor.keyword)) {
          ok = false;
          error = `La página no contiene «${monitor.keyword}»`;
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (caught) {
      error = describeError(caught, monitor.timeout_ms);
    }
    // El monitor puede haberse borrado mientras se comprobaba.
    const stillExists = db.prepare('SELECT 1 FROM monitors WHERE id = ?').get(monitor.id);
    if (stillExists) insertCheck.run(monitor.id, ts, ok ? 1 : 0, statusCode, latency, error);

    const url = new URL(monitor.url);
    if (stillExists && url.protocol === 'https:' && ts - (monitor.cert_checked_at ?? 0) > CERT_REFRESH_MS) {
      const cert = await checkCertificate(url);
      updateCert.run(cert.expiresAt, cert.issuer, cert.error, Date.now(), monitor.id);
    }
  }

  function schedule(monitor: MonitorRow, force = false): Promise<void> | null {
    if (running.has(monitor.id)) return null;
    if (!force && running.size >= MAX_CONCURRENT) return null;
    running.add(monitor.id);
    lastRun.set(monitor.id, Date.now());
    return runCheck(monitor)
      .catch((error) => console.error(`[monitor] Error comprobando ${monitor.url}:`, error))
      .finally(() => running.delete(monitor.id));
  }

  function tick() {
    const monitors = db.prepare('SELECT * FROM monitors WHERE enabled = 1').all() as MonitorRow[];
    const now = Date.now();
    for (const monitor of monitors) {
      let last = lastRun.get(monitor.id);
      if (last === undefined) {
        const row = db.prepare('SELECT MAX(ts) AS ts FROM monitor_checks WHERE monitor_id = ?').get(monitor.id) as {
          ts: number | null;
        };
        last = row.ts ?? 0;
        lastRun.set(monitor.id, last);
      }
      if (now - last >= monitor.interval_sec * 1000) schedule(monitor);
    }
  }

  function computeStatus(row: MonitorRow, checks: CheckRow[]): MonitorStatus {
    if (!row.enabled) return 'paused';
    if (checks.length === 0) return 'pending';
    if (checks[0].ok) return 'up';
    // Un fallo aislado se marca como aviso; dos seguidos, como caída.
    if (checks.length === 1 || !checks[1].ok) return 'down';
    return 'warning';
  }

  const toCheck = (row: CheckRow): MonitorCheck => ({
    ts: row.ts,
    ok: Boolean(row.ok),
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
  });

  function toMonitor(row: MonitorRow): Monitor {
    const recentRows = db
      .prepare('SELECT ts, ok, status_code, latency_ms, error FROM monitor_checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 40')
      .all(row.id) as CheckRow[];
    const now = Date.now();
    const summary = (since: number) =>
      db
        .prepare(
          `SELECT AVG(ok) * 100 AS uptime, AVG(CASE WHEN ok = 1 THEN latency_ms END) AS latency
           FROM monitor_checks WHERE monitor_id = ? AND ts >= ?`,
        )
        .get(row.id, since) as { uptime: number | null; latency: number | null };
    const day = summary(now - 86_400_000);
    const week = summary(now - 7 * 86_400_000);
    const isHttps = row.url.startsWith('https:');
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      intervalSec: row.interval_sec,
      timeoutMs: row.timeout_ms,
      keyword: row.keyword,
      enabled: Boolean(row.enabled),
      status: computeStatus(row, recentRows),
      lastCheck: recentRows[0] ? toCheck(recentRows[0]) : null,
      uptime24h: day.uptime === null ? null : Math.round(day.uptime * 100) / 100,
      uptime7d: week.uptime === null ? null : Math.round(week.uptime * 100) / 100,
      avgLatency24h: day.latency === null ? null : Math.round(day.latency),
      recent: recentRows
        .slice(0, 30)
        .reverse()
        .map((c) => ({ ts: c.ts, ok: Boolean(c.ok), latencyMs: c.latency_ms })),
      cert: isHttps
        ? {
            expiresAt: row.cert_expires_at,
            issuer: row.cert_issuer,
            error: row.cert_error,
            checkedAt: row.cert_checked_at,
          }
        : null,
    };
  }

  const getRow = (id: number) => db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as MonitorRow | undefined;

  const router = express.Router();

  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM monitors ORDER BY name COLLATE NOCASE').all() as MonitorRow[];
    res.json(rows.map(toMonitor));
  });

  router.post('/', (req, res) => {
    const { value, error } = validateInput(req.body ?? {});
    if (error || !value) {
      res.status(400).json({ error });
      return;
    }
    const result = db
      .prepare(
        'INSERT INTO monitors (name, url, interval_sec, timeout_ms, keyword, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        value.name,
        value.url,
        value.intervalSec ?? 60,
        value.timeoutMs ?? 10_000,
        value.keyword ?? null,
        value.enabled === false ? 0 : 1,
        Date.now(),
      );
    const row = getRow(Number(result.lastInsertRowid))!;
    // Primera comprobación inmediata para no esperar al siguiente ciclo.
    const pending = row.enabled ? schedule(row, true) : null;
    (pending ?? Promise.resolve()).then(() => res.status(201).json(toMonitor(getRow(row.id)!)));
  });

  router.put('/:id', (req, res) => {
    const row = getRow(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Monitor no encontrado' });
      return;
    }
    const { value, error } = validateInput(req.body ?? {}, true);
    if (error || !value) {
      res.status(400).json({ error });
      return;
    }
    const urlChanged = value.url !== undefined && value.url !== row.url;
    db.prepare(
      `UPDATE monitors SET name = ?, url = ?, interval_sec = ?, timeout_ms = ?, keyword = ?, enabled = ?
       ${urlChanged ? ', cert_expires_at = NULL, cert_issuer = NULL, cert_error = NULL, cert_checked_at = NULL' : ''}
       WHERE id = ?`,
    ).run(
      value.name ?? row.name,
      value.url ?? row.url,
      value.intervalSec ?? row.interval_sec,
      value.timeoutMs ?? row.timeout_ms,
      value.keyword !== undefined ? value.keyword : row.keyword,
      value.enabled === undefined ? row.enabled : value.enabled ? 1 : 0,
      row.id,
    );
    if (urlChanged) {
      // Las comprobaciones anteriores eran de otra URL.
      db.prepare('DELETE FROM monitor_checks WHERE monitor_id = ?').run(row.id);
      lastRun.delete(row.id);
    }
    res.json(toMonitor(getRow(row.id)!));
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM monitor_checks WHERE monitor_id = ?').run(id);
    db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
    lastRun.delete(id);
    res.json({ success: true });
  });

  router.post('/:id/check', async (req, res) => {
    const row = getRow(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'Monitor no encontrado' });
      return;
    }
    await (schedule({ ...row, cert_checked_at: 0 }, true) ?? Promise.resolve());
    res.json(toMonitor(getRow(row.id)!));
  });

  router.get('/:id/history', (req, res) => {
    const id = Number(req.params.id);
    const range = (req.query.range as HistoryRange) in HISTORY_RANGES ? (req.query.range as HistoryRange) : '24h';
    const span = HISTORY_RANGES[range];
    const bucket = Math.max(60_000, Math.floor(span / 96));
    const since = Date.now() - span;
    const points = db
      .prepare(
        `SELECT CAST(ts / @bucket AS INTEGER) * @bucket AS t,
                ROUND(AVG(ok) * 100, 2) AS uptime,
                ROUND(AVG(CASE WHEN ok = 1 THEN latency_ms END)) AS latency,
                COUNT(*) AS checks
         FROM monitor_checks WHERE monitor_id = @id AND ts >= @since
         GROUP BY t ORDER BY t`,
      )
      .all({ bucket, id, since }) as MonitorHistoryPoint[];
    const failures = (
      db
        .prepare(
          `SELECT ts, ok, status_code, latency_ms, error FROM monitor_checks
           WHERE monitor_id = ? AND ok = 0 AND ts >= ? ORDER BY ts DESC LIMIT 25`,
        )
        .all(id, since) as CheckRow[]
    ).map(toCheck);
    res.json({ range, bucketMs: bucket, points, failures });
  });

  return {
    router,
    start() {
      tick();
      setInterval(tick, TICK_MS).unref();
    },
  };
}
