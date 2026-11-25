/*
 * Buscar todas tus webs.
 *
 * Cada certificado HTTPS que se emite (Let's Encrypt incluido, que es el que usa Nginx Proxy Manager) queda
 * apuntado en registros públicos (Certificate Transparency). Consultándolos para tus dominios salen todas las webs
 * que has tenido con HTTPS, pasen o no por NPM, sin usuario ni contraseña. Después se mira cuáles existen todavía
 * (DNS) y cuáles responden, y se proponen las que aún no se vigilan.
 *
 * Fuentes: crt.sh y, si falla, Cert Spotter. Más los dominios de los NPM conocidos que aún no se vigilen.
 */
import dns from 'node:dns';
import https from 'node:https';
import express from 'express';
import type { DB } from './db';
import type { NpmService } from './npm';

const CRTSH = (process.env.DISCOVERY_CRTSH_URL || 'https://crt.sh').replace(/\/+$/, '');
const CERTSPOTTER = (process.env.DISCOVERY_CERTSPOTTER_URL || 'https://api.certspotter.com').replace(/\/+$/, '');
const EVERY_MS = 24 * 3_600_000;
/** Certificados que caducaron hace más de esto no cuentan: son webs de hace mucho. */
const MAX_AGE_MS = 400 * 86_400_000;
const MAX_HOSTS = 300;
const CONCURRENCY = 6;

/** Sufijos de dos niveles habituales (para sacar el dominio de «panel.marcogugliandolo.com»). */
const TWO_LEVEL = new Set(['com.es', 'org.es', 'nom.es', 'gob.es', 'co.uk', 'org.uk', 'com.ar', 'com.mx', 'com.br', 'com.co']);
export function baseDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  const parts = h.split('.');
  const two = parts.slice(-2).join('.');
  return TWO_LEVEL.has(two) && parts.length >= 3 ? parts.slice(-3).join('.') : two;
}

export interface Candidate {
  host: string;
  source: 'certificados' | 'npm';
  resolves: boolean;
  responds: boolean;
  status: number | null;
  /** Último certificado visto para este nombre (ms). */
  certAt: number | null;
  checkedAt: number;
}

interface CandidateRow {
  host: string;
  source: string;
  resolves: number;
  responds: number;
  status: number | null;
  cert_at: number | null;
  checked_at: number;
  dismissed: number;
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'ServerPanel/2.0 (descubrir webs)', Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Nombres con certificado para un dominio: crt.sh y, si no contesta, Cert Spotter. */
async function namesFor(domain: string): Promise<{ names: Map<string, number>; source: string }> {
  const names = new Map<string, number>();
  const add = (raw: string, at: number) => {
    for (const n of raw.split(/\s+/)) {
      const name = n.toLowerCase().trim();
      if (!name || name.startsWith('*.') || !(name === domain || name.endsWith(`.${domain}`))) continue;
      names.set(name, Math.max(names.get(name) ?? 0, at));
    }
  };
  const fresh = (notAfter: string | undefined) => !notAfter || Date.now() - Date.parse(notAfter) < MAX_AGE_MS;
  try {
    const rows = (await getJson(`${CRTSH}/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, 45_000)) as any[];
    for (const r of rows) if (fresh(r.not_after)) add(`${r.name_value ?? ''} ${r.common_name ?? ''}`, Date.parse(r.not_before) || 0);
    return { names, source: 'crt.sh' };
  } catch (error) {
    console.warn(`[descubrir] crt.sh no ha respondido para ${domain} (${(error as Error).message}); se prueba Cert Spotter`);
  }
  let after = '';
  for (let page = 0; page < 10; page++) {
    const rows = (await getJson(
      `${CERTSPOTTER}/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names${after ? `&after=${after}` : ''}`,
      30_000,
    )) as any[];
    for (const r of rows) if (fresh(r.not_after)) add((r.dns_names ?? []).join(' '), Date.parse(r.not_before) || 0);
    if (rows.length < 100) break;
    after = String(rows[rows.length - 1].id);
  }
  return { names, source: 'Cert Spotter' };
}

async function resolves(host: string): Promise<boolean> {
  try {
    const r = await Promise.race([dns.promises.lookup(host), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    return Boolean(r);
  } catch {
    return false;
  }
}

/** ¿Responde por HTTPS? (aunque el certificado esté mal: aquí solo interesa si hay algo). */
function probe(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { host, port: 443, path: '/', method: 'GET', servername: host, rejectUnauthorized: false, timeout: 8000, headers: { 'User-Agent': 'ServerPanel/2.0 (descubrir webs)' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export function createDiscovery(
  db: DB,
  monitors: { list(): { url: string }[]; add(name: string, url: string): number | null },
  npm: NpmService,
  /** Con «solo las webs de NPM» no se buscan webs en los certificados. */
  opts: { npmOnly(): boolean } = { npmOnly: () => false },
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_candidates (
      host TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      resolves INTEGER NOT NULL DEFAULT 0,
      responds INTEGER NOT NULL DEFAULT 0,
      status INTEGER,
      cert_at INTEGER,
      checked_at INTEGER NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0
    );
  `);
  const getSetting = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const setSetting = (key: string, value: string) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  let running = false;
  let lastError: string | null = null;
  let lastSources: string[] = [];

  function watchedHosts(): Set<string> {
    const set = new Set<string>();
    for (const m of monitors.list()) {
      try {
        set.add(new URL(m.url).hostname.toLowerCase());
      } catch {
        /* se ignora */
      }
    }
    return set;
  }

  function extraDomains(): string[] {
    try {
      return JSON.parse(getSetting('discovery_domains') || '[]');
    } catch {
      return [];
    }
  }

  /** Tus dominios: los de las webs que ya vigilas, los de NPM y los que añadas a mano. */
  function domains(): string[] {
    const set = new Set<string>(extraDomains());
    for (const h of watchedHosts()) {
      const d = baseDomain(h);
      if (d) set.add(d);
    }
    for (const { domains: list } of npm.domainsByInstance()) for (const h of list) {
      const d = baseDomain(h);
      if (d) set.add(d);
    }
    return [...set].sort();
  }

  async function run() {
    if (running) return;
    running = true;
    lastError = null;
    const started = Date.now();
    try {
      const found = new Map<string, { source: Candidate['source']; certAt: number | null }>();
      const sources = new Set<string>();
      const failures: string[] = [];
      for (const domain of opts.npmOnly() ? [] : domains()) {
        try {
          const { names, source } = await namesFor(domain);
          sources.add(source);
          for (const [name, at] of names) found.set(name, { source: 'certificados', certAt: at || null });
        } catch (error) {
          failures.push(`${domain}: ${(error as Error).message}`);
        }
      }
      for (const { domains: list } of npm.domainsByInstance()) for (const h of list) if (!found.has(h)) found.set(h, { source: 'npm', certAt: null });
      const watched = watchedHosts();
      const hosts = [...found.keys()].filter((h) => !watched.has(h)).slice(0, MAX_HOSTS);
      const upsert = db.prepare(
        `INSERT INTO web_candidates (host, source, resolves, responds, status, cert_at, checked_at) VALUES (@host, @source, @resolves, @responds, @status, @certAt, @checkedAt)
         ON CONFLICT(host) DO UPDATE SET source = excluded.source, resolves = excluded.resolves, responds = excluded.responds, status = excluded.status,
           cert_at = excluded.cert_at, checked_at = excluded.checked_at`,
      );
      await pool(hosts, CONCURRENCY, async (host) => {
        const ok = await resolves(host);
        const status = ok ? await probe(host) : null;
        const info = found.get(host)!;
        upsert.run({ host, source: info.source, resolves: ok ? 1 : 0, responds: status !== null ? 1 : 0, status, certAt: info.certAt, checkedAt: Date.now() });
      });
      // Lo que ya no aparece en ninguna fuente se olvida (salvo lo descartado, para no volver a proponerlo).
      const keep = new Set(hosts);
      for (const row of db.prepare('SELECT host FROM web_candidates WHERE dismissed = 0').all() as { host: string }[]) {
        if (!keep.has(row.host)) db.prepare('DELETE FROM web_candidates WHERE host = ?').run(row.host);
      }
      lastSources = [...sources];
      if (failures.length && !sources.size) lastError = `No se pudo consultar los registros de certificados (${failures.join('; ')}).`;
      setSetting('discovery_last_run', String(Date.now()));
      const fresh = db.prepare('SELECT COUNT(*) AS n FROM web_candidates WHERE dismissed = 0 AND responds = 1').get() as { n: number };
      console.log(`[descubrir] ${found.size} nombres en ${domains().length} dominios (${[...sources].join(', ') || 'sin fuentes'}); ${fresh.n} webs que responden y no se vigilan · ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (error) {
      lastError = (error as Error).message;
      console.error('[descubrir] Error:', error);
    } finally {
      running = false;
    }
  }

  function state() {
    const watched = watchedHosts();
    const npmOnly = opts.npmOnly();
    const rows = (db.prepare('SELECT * FROM web_candidates WHERE dismissed = 0 ORDER BY responds DESC, resolves DESC, host').all() as CandidateRow[]).filter(
      (r) => !watched.has(r.host) && (!npmOnly || r.source === 'npm'),
    );
    return {
      npmOnly,
      running,
      lastRun: Number(getSetting('discovery_last_run')) || null,
      lastError,
      sources: lastSources,
      domains: domains(),
      extraDomains: extraDomains(),
      candidates: rows.map(
        (r): Candidate => ({
          host: r.host,
          source: r.source as Candidate['source'],
          resolves: Boolean(r.resolves),
          responds: Boolean(r.responds),
          status: r.status,
          certAt: r.cert_at,
          checkedAt: r.checked_at,
        }),
      ),
    };
  }

  const router = express.Router();
  router.get('/', (_req, res) => res.json(state()));
  router.post('/run', (_req, res) => {
    void run();
    res.json({ ...state(), running: true });
  });
  router.post('/watch', (req, res) => {
    const hosts: string[] = (Array.isArray(req.body?.hosts) ? req.body.hosts : []).map((h: unknown) => String(h).toLowerCase()).filter((h: string) => /^[a-z0-9.-]+$/.test(h));
    const added: string[] = [];
    for (const host of hosts) if (monitors.add(host, `https://${host}/`) !== null) added.push(host);
    if (added.length) console.log(`[descubrir] Se vigilan ${added.length} web(s): ${added.join(', ')}`);
    res.json({ added, ...state() });
  });
  router.post('/dismiss', (req, res) => {
    const hosts: string[] = (Array.isArray(req.body?.hosts) ? req.body.hosts : []).map((h: unknown) => String(h).toLowerCase());
    for (const host of hosts) db.prepare('UPDATE web_candidates SET dismissed = 1 WHERE host = ?').run(host);
    res.json(state());
  });
  router.put('/domains', (req, res) => {
    const list = (Array.isArray(req.body?.domains) ? req.body.domains : [])
      .map((d: unknown) => baseDomain(String(d).trim().replace(/^https?:\/\//, '').split('/')[0]))
      .filter(Boolean) as string[];
    setSetting('discovery_domains', JSON.stringify([...new Set(list)]));
    void run();
    res.json({ ...state(), running: true });
  });

  return {
    router,
    start() {
      const due = () => Date.now() - (Number(getSetting('discovery_last_run')) || 0) >= EVERY_MS;
      // La primera vez, en cuanto el panel lleve un rato arrancado (para que hayan llegado los datos de NPM).
      setTimeout(() => due() && void run(), 90_000).unref();
      setInterval(() => due() && void run(), 3_600_000).unref();
    },
  };
}
