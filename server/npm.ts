/*
 * Conexión con Nginx Proxy Manager (NPM).
 *
 * Se usa la misma API que la web de NPM (usuario y contraseña → token). De ahí sale la lista de "proxy hosts":
 * qué dominios hay, a qué destino (host:puerto) manda cada uno y si NPM los tiene activos y sin errores.
 * Con eso el panel conoce todas las webs (las puede vigilar solas) y, cuando una se cae, sabe qué hay detrás.
 *
 * Puede haber varios NPM (uno por servidor); cada uno se asocia al servidor del panel donde está instalado.
 */
import express from 'express';
import type { DetectedNpmHost } from '../shared/types';
import { parseAdvanced, parseProxyPass, type NpmTarget } from './npmConf';
import type { DB } from './db';
import { readLayout } from './routes/layout';
import { readAllStats } from './routes/stats';

export interface NpmProxyHost {
  id: number;
  domains: string[];
  forwardScheme: string;
  forwardHost: string;
  forwardPort: number;
  enabled: boolean;
  ssl: boolean;
  /** false si NPM no ha podido cargar la configuración de este host. */
  online: boolean;
  error: string | null;
  /** La configuración avanzada manda la portada a otro destino (el de la ficha no se usa para «/»). */
  root?: NpmTarget | null;
  /** Respaldo de la configuración avanzada para cuando el destino falla. */
  fallback?: NpmTarget | null;
}

export interface NpmInstanceInfo {
  id: number;
  name: string;
  url: string;
  email: string;
  serverId: string | null;
  autoImport: boolean;
  hostsCount: number | null;
  syncedAt: number | null;
  lastError: string | null;
}

interface InstanceRow {
  id: number;
  name: string;
  url: string;
  email: string;
  password: string;
  server_id: string | null;
  auto_import: number;
  token: string | null;
  token_expires: number | null;
  hosts: string | null;
  synced_at: number | null;
  last_error: string | null;
}

export class NpmError extends Error {}

const SYNC_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

const cleanUrl = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/api$/, '');

function toHost(raw: any): NpmProxyHost {
  return {
    id: Number(raw.id),
    domains: Array.isArray(raw.domain_names) ? raw.domain_names.map((d: unknown) => String(d).toLowerCase()) : [],
    forwardScheme: String(raw.forward_scheme ?? 'http'),
    forwardHost: String(raw.forward_host ?? ''),
    forwardPort: Number(raw.forward_port) || 0,
    // Según la versión, NPM devuelve true/false o 1/0.
    enabled: raw.enabled === true || raw.enabled === 1 || raw.enabled === '1',
    ssl: Number(raw.certificate_id) > 0,
    online: raw.meta?.nginx_online !== false,
    error: raw.meta?.nginx_err ? String(raw.meta.nginx_err).slice(0, 300) : null,
    ...advancedTargets(raw),
  };
}

/** Destinos de la configuración avanzada y de las ubicaciones personalizadas de NPM (vía su API). */
function advancedTargets(raw: any): { root: NpmTarget | null; fallback: NpmTarget | null } {
  const adv = parseAdvanced(raw.advanced_config);
  const slash = (Array.isArray(raw.locations) ? raw.locations : []).find((l: any) => l?.path === '/' && l.forward_host);
  const fromLocation = slash
    ? { scheme: String(slash.forward_scheme ?? 'http'), host: String(slash.forward_host).toLowerCase(), port: Number(slash.forward_port) || 80 }
    : null;
  return { root: parseProxyPass(adv.root) ?? fromLocation, fallback: parseProxyPass(adv.fallback) };
}

/** ¿Este dominio de NPM cubre el nombre? (admite comodines tipo *.dominio.com) */
export function domainMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.split('.').length === p.split('.').length;
  return false;
}

export function createNpmService(db: DB, monitors: { add(name: string, url: string): number | null; list(): { url: string }[] }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS npm_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      server_id TEXT,
      auto_import INTEGER NOT NULL DEFAULT 1,
      token TEXT,
      token_expires INTEGER,
      hosts TEXT,
      synced_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  const rows = () => db.prepare('SELECT * FROM npm_instances ORDER BY id').all() as InstanceRow[];
  const getRow = (id: number) => db.prepare('SELECT * FROM npm_instances WHERE id = ?').get(id) as InstanceRow | undefined;

  async function call(base: string, path: string, init: RequestInit = {}): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${base}/api${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const reason = (error as Error)?.name === 'TimeoutError' ? 'no responde' : 'no se puede alcanzar';
      throw new NpmError(`Nginx Proxy Manager ${reason} en ${base} desde el panel.`);
    }
    const data = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw new NpmError('NPM no acepta ese usuario o contraseña.');
    if (!response.ok) throw new NpmError(`NPM respondió ${response.status}${data?.error?.message ? `: ${data.error.message}` : ''}`);
    return data;
  }

  async function login(base: string, email: string, password: string): Promise<{ token: string; expires: number }> {
    const data = await call(base, '/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, secret: password }),
    });
    if (!data?.token) throw new NpmError('NPM no ha devuelto un token. ¿Es la URL del panel de administración (puerto 81)?');
    const expires = Date.parse(data.expires) || Date.now() + 12 * 3_600_000;
    return { token: data.token, expires };
  }

  async function fetchHosts(base: string, token: string): Promise<NpmProxyHost[]> {
    const data = await call(base, '/nginx/proxy-hosts', { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(data)) throw new NpmError('Respuesta inesperada de NPM al pedir los proxy hosts.');
    return data.map(toHost);
  }

  /** Pide los proxy hosts de una instancia (renovando el token si hace falta) y los guarda. */
  async function sync(row: InstanceRow): Promise<NpmProxyHost[]> {
    try {
      let token = row.token;
      if (!token || !row.token_expires || row.token_expires - Date.now() < 10 * 60_000) {
        const fresh = await login(row.url, row.email, row.password);
        token = fresh.token;
        db.prepare('UPDATE npm_instances SET token = ?, token_expires = ? WHERE id = ?').run(fresh.token, fresh.expires, row.id);
      }
      let hosts: NpmProxyHost[];
      try {
        hosts = await fetchHosts(row.url, token);
      } catch (error) {
        // Token revocado o caducado antes de tiempo: se pide otro una vez.
        if (!(error instanceof NpmError) || !/usuario o contraseña/.test(error.message)) throw error;
        const fresh = await login(row.url, row.email, row.password);
        db.prepare('UPDATE npm_instances SET token = ?, token_expires = ? WHERE id = ?').run(fresh.token, fresh.expires, row.id);
        hosts = await fetchHosts(row.url, fresh.token);
      }
      db.prepare('UPDATE npm_instances SET hosts = ?, synced_at = ?, last_error = NULL WHERE id = ?').run(JSON.stringify(hosts), Date.now(), row.id);
      if (row.auto_import) importNew(row, hosts);
      return hosts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare('UPDATE npm_instances SET last_error = ? WHERE id = ?').run(message, row.id);
      throw error;
    }
  }

  const cachedHosts = (row: InstanceRow): NpmProxyHost[] => {
    try {
      return JSON.parse(row.hosts || '[]');
    } catch {
      return [];
    }
  };

  /** Dominios que ya se vigilan (por el nombre de máquina de su URL). */
  function watchedHostnames(): Set<string> {
    const set = new Set<string>();
    for (const m of monitors.list()) {
      try {
        set.add(new URL(m.url).hostname.toLowerCase());
      } catch {
        /* URL rara: se ignora */
      }
    }
    return set;
  }

  const publicUrl = (host: NpmProxyHost, domain: string) => `${host.ssl ? 'https' : 'http'}://${domain}/`;
  /** Los comodines (*.dominio) no son una web concreta que se pueda comprobar. */
  const importable = (domain: string) => !domain.includes('*');

  function importDomains(label: string, hosts: NpmProxyHost[], domains: Set<string>): string[] {
    const watched = watchedHostnames();
    const added: string[] = [];
    for (const host of hosts) {
      if (!host.enabled) continue;
      for (const domain of host.domains) {
        if (!domains.has(domain) || watched.has(domain) || !importable(domain)) continue;
        if (monitors.add(domain, publicUrl(host, domain)) !== null) {
          added.push(domain);
          watched.add(domain);
        }
      }
    }
    if (added.length) console.log(`[npm] ${label}: se vigilan ${added.length} web(s) nuevas: ${added.join(', ')}`);
    return added;
  }

  /** Webs nuevas en NPM desde la última vez: se empiezan a vigilar solas (si la instancia lo tiene activado). */
  function importNew(row: InstanceRow, hosts: NpmProxyHost[]) {
    let known: string[] = [];
    try {
      known = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").pluck().get(`npm_known_${row.id}`) as string || '[]');
    } catch {
      known = [];
    }
    const all = hosts.filter((h) => h.enabled).flatMap((h) => h.domains);
    // La primera vez no se importa nada solo: eso lo decide la persona desde el panel.
    if (known.length) {
      const fresh = new Set(all.filter((d) => !known.includes(d)));
      if (fresh.size) importDomains(row.name, hosts, fresh);
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`npm_known_${row.id}`, JSON.stringify(all));
  }

  /* --- NPM detectados por el script de métricas (sin usuario ni contraseña) --- */
  const toDetected = (h: DetectedNpmHost, i: number): NpmProxyHost => ({
    id: i + 1,
    domains: h.domains,
    forwardScheme: h.scheme,
    forwardHost: h.host,
    forwardPort: h.port,
    // NPM borra el archivo de los hosts desactivados: los que llegan están activos.
    enabled: true,
    ssl: h.ssl,
    online: !h.error,
    error: h.error ? 'NPM no ha podido cargar su configuración (el archivo quedó como .conf.err). Ábrelo en NPM y guárdalo para ver el error.' : null,
    root: parseProxyPass(h.root),
    fallback: parseProxyPass(h.fallback),
  });
  const detectedAuto = (serverId: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(`npm_auto_srv_${serverId}`) as string | undefined) !== '0';

  /** NPM encontrados por otra vía (Portainer), para los servidores cuyo script no los envía. */
  let extraDetected: () => { serverId: string; title: string; online: boolean; at: number; hosts: DetectedNpmHost[] }[] = () => [];

  function detectedServers() {
    const titles = new Map<string, string>();
    for (const n of readLayout(db).layout.nodes) if (n.serverId && !titles.has(n.serverId)) titles.set(n.serverId, n.title || n.serverId);
    const fromScript = readAllStats(db)
      .filter((s) => s.npmHosts)
      .map((s) => ({
        serverId: s.serverId,
        title: titles.get(s.serverId) ?? s.hostname ?? s.serverId,
        online: s.online,
        at: s.lastUpdated,
        hosts: s.npmHosts!.map(toDetected),
      }));
    const fromPortainer = extraDetected()
      .filter((e) => !fromScript.some((d) => d.serverId === e.serverId))
      .map((e) => ({ ...e, title: titles.get(e.serverId) ?? e.title, hosts: e.hosts.map(toDetected) }));
    return [...fromScript, ...fromPortainer];
  }
  type Detected = ReturnType<typeof detectedServers>[number];
  const detectedInfo = (d: Detected): NpmInstanceInfo => ({
    id: 0,
    name: `NPM ${d.title}`,
    url: '',
    email: '',
    serverId: d.serverId,
    autoImport: detectedAuto(d.serverId),
    hostsCount: d.hosts.length,
    syncedAt: d.at,
    lastError: null,
  });

  /** Webs de los NPM detectados: la primera vez se vigilan todas; luego, solo las nuevas (si no se ha desactivado). */
  function importDetected() {
    for (const d of detectedServers()) {
      if (!detectedAuto(d.serverId)) continue;
      const key = `npm_known_srv_${d.serverId}`;
      const stored = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
      let known: string[] | null = null;
      try {
        known = stored ? JSON.parse(stored) : null;
      } catch {
        known = null;
      }
      const all = d.hosts.flatMap((h) => h.domains);
      const wanted = new Set(known ? all.filter((x) => !known!.includes(x)) : all);
      if (wanted.size) importDomains(`NPM ${d.title}`, d.hosts, wanted);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(all));
    }
  }

  function info(row: InstanceRow): NpmInstanceInfo {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      email: row.email,
      serverId: row.server_id,
      autoImport: Boolean(row.auto_import),
      hostsCount: row.hosts ? cachedHosts(row).length : null,
      syncedAt: row.synced_at,
      lastError: row.last_error,
    };
  }

  /**
   * ¿Qué NPM sirve este dominio y a dónde lo manda? Usa lo guardado y, si es viejo, lo pide de nuevo
   * (si NPM no contesta, se queda con lo último que se supo).
   */
  /**
   * Todos los NPM que tienen ese dominio (puede haber dos: el de fuera que lo manda a casa y el de casa
   * que lo manda al contenedor). Con todos sus proxy hosts, para deducir la IP pública de su máquina.
   */
  async function findHosts(hostname: string, maxAgeMs = 60_000) {
    const out: { instance: ReturnType<typeof info>; host: NpmProxyHost; siblings: string[]; all: NpmProxyHost[] }[] = [];
    for (const row of rows()) {
      let hosts = cachedHosts(row);
      if (!row.synced_at || Date.now() - row.synced_at > maxAgeMs) {
        try {
          hosts = await sync(row);
        } catch {
          /* se usa lo guardado */
        }
      }
      const host = hosts.find((h) => h.domains.some((d) => domainMatches(d, hostname)));
      if (host) out.push({ instance: info(getRow(row.id) ?? row), host, siblings: hosts.filter((h) => h !== host && h.enabled).flatMap((h) => h.domains), all: hosts });
    }
    for (const d of detectedServers()) {
      const host = d.hosts.find((h) => h.domains.some((x) => domainMatches(x, hostname)));
      // El mismo NPM conectado por API y detectado por el script cuenta una vez.
      if (host && !out.some((o) => o.instance.serverId && o.instance.serverId === d.serverId)) {
        out.push({ instance: detectedInfo(d), host, siblings: d.hosts.filter((h) => h !== host).flatMap((h) => h.domains), all: d.hosts });
      }
    }
    return out;
  }

  async function findHost(hostname: string, maxAgeMs = 60_000) {
    for (const row of rows()) {
      let hosts = cachedHosts(row);
      if (!row.synced_at || Date.now() - row.synced_at > maxAgeMs) {
        try {
          hosts = await sync(row);
        } catch {
          /* se usa lo guardado */
        }
      }
      const host = hosts.find((h) => h.domains.some((d) => domainMatches(d, hostname)));
      if (host) return { instance: info(getRow(row.id) ?? row), host, siblings: hosts.filter((h) => h !== host && h.enabled).flatMap((h) => h.domains) };
    }
    for (const d of detectedServers()) {
      const host = d.hosts.find((h) => h.domains.some((x) => domainMatches(x, hostname)));
      if (host) return { instance: detectedInfo(d), host, siblings: d.hosts.filter((h) => h !== host).flatMap((h) => h.domains) };
    }
    return null;
  }

  /* --- Rutas (con sesión) --- */
  const router = express.Router();
  const fail = (res: express.Response, error: unknown) =>
    res.status(error instanceof NpmError ? 502 : 500).json({ error: error instanceof Error ? error.message : 'Error con NPM' });

  function readBody(body: any, partial: boolean) {
    const name = String(body?.name ?? '').trim().slice(0, 60);
    const url = cleanUrl(String(body?.url ?? ''));
    const email = String(body?.email ?? '').trim().slice(0, 200);
    const password = typeof body?.password === 'string' ? body.password : '';
    const serverId = body?.serverId ? String(body.serverId).slice(0, 64) : null;
    const autoImport = body?.autoImport !== false;
    if (!partial || body?.url !== undefined) {
      if (!/^https?:\/\/[^\s/]+/.test(url)) return { error: 'La URL tiene que empezar por http:// o https:// (por ejemplo http://172.17.0.1:81).' };
    }
    if (!partial && (!email || !password)) return { error: 'Faltan el usuario (email) o la contraseña de NPM.' };
    return { value: { name: name || 'Nginx Proxy Manager', url, email, password, serverId, autoImport } };
  }

  router.get('/', (_req, res) => res.json(rows().map(info)));

  const withWatch = (hosts: NpmProxyHost[]) => {
    const watched = watchedHostnames();
    return hosts.map((h) => ({ ...h, watched: h.domains.filter((d) => watched.has(d)), importable: h.domains.filter(importable) }));
  };
  const findDetected = (serverId: string) => detectedServers().find((d) => d.serverId === serverId);

  router.get('/detected', (_req, res) =>
    res.json(detectedServers().map((d) => ({ ...detectedInfo(d), title: d.title, online: d.online }))),
  );
  router.get('/detected/:serverId/hosts', (req, res) => {
    const d = findDetected(req.params.serverId);
    if (!d) {
      res.status(404).json({ error: 'Ese servidor no ha enviado datos de Nginx Proxy Manager' });
      return;
    }
    res.json(withWatch(d.hosts));
  });
  router.post('/detected/:serverId/import', (req, res) => {
    const d = findDetected(req.params.serverId);
    if (!d) {
      res.status(404).json({ error: 'No encontrado' });
      return;
    }
    const wanted = new Set<string>((Array.isArray(req.body?.domains) ? req.body.domains : []).map((x: unknown) => String(x).toLowerCase()));
    res.json({ added: importDomains(`NPM ${d.title}`, d.hosts, wanted) });
  });
  router.put('/detected/:serverId', (req, res) => {
    const d = findDetected(req.params.serverId);
    if (!d) {
      res.status(404).json({ error: 'No encontrado' });
      return;
    }
    const on = req.body?.autoImport !== false;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`npm_auto_srv_${d.serverId}`, on ? '1' : '0');
    // Al volver a activarlo, las que aparezcan desde ahora se vigilan solas (no se recuperan las que quitaste).
    if (on) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`npm_known_srv_${d.serverId}`, JSON.stringify(d.hosts.flatMap((h) => h.domains)));
    res.json({ ...detectedInfo(d), title: d.title, online: d.online });
  });

  router.post('/', async (req, res) => {
    const { value, error } = readBody(req.body, false);
    if (!value) {
      res.status(400).json({ error });
      return;
    }
    try {
      // Se comprueba antes de guardar: así un error de URL o contraseña se ve en el momento.
      const { token, expires } = await login(value.url, value.email, value.password);
      await fetchHosts(value.url, token);
      const id = Number(
        db
          .prepare(
            'INSERT INTO npm_instances (name, url, email, password, server_id, auto_import, token, token_expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(value.name, value.url, value.email, value.password, value.serverId, value.autoImport ? 1 : 0, token, expires, Date.now()).lastInsertRowid,
      );
      await sync(getRow(id)!);
      res.status(201).json(info(getRow(id)!));
    } catch (caught) {
      fail(res, caught);
    }
  });

  router.put('/:id', async (req, res) => {
    const row = getRow(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'No encontrado' });
      return;
    }
    const { value, error } = readBody(req.body, true);
    if (!value) {
      res.status(400).json({ error });
      return;
    }
    const next = {
      name: value.name || row.name,
      url: req.body?.url !== undefined ? value.url : row.url,
      email: value.email || row.email,
      password: value.password || row.password,
      serverId: req.body?.serverId !== undefined ? value.serverId : row.server_id,
      autoImport: req.body?.autoImport !== undefined ? value.autoImport : Boolean(row.auto_import),
    };
    const credentialsChanged = next.url !== row.url || next.email !== row.email || next.password !== row.password;
    try {
      if (credentialsChanged) await login(next.url, next.email, next.password);
      db.prepare(
        `UPDATE npm_instances SET name = ?, url = ?, email = ?, password = ?, server_id = ?, auto_import = ?
         ${credentialsChanged ? ', token = NULL, token_expires = NULL' : ''} WHERE id = ?`,
      ).run(next.name, next.url, next.email, next.password, next.serverId, next.autoImport ? 1 : 0, row.id);
      if (credentialsChanged) await sync(getRow(row.id)!).catch(() => undefined);
      res.json(info(getRow(row.id)!));
    } catch (caught) {
      fail(res, caught);
    }
  });

  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM npm_instances WHERE id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM settings WHERE key = ?').run(`npm_known_${Number(req.params.id)}`);
    res.json({ success: true });
  });

  /** Proxy hosts de una instancia, marcando cuáles se vigilan ya. */
  router.get('/:id/hosts', async (req, res) => {
    const row = getRow(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'No encontrado' });
      return;
    }
    try {
      const hosts = req.query.refresh || !row.synced_at ? await sync(row) : cachedHosts(row);
      const watched = watchedHostnames();
      res.json(
        hosts.map((h) => ({
          ...h,
          watched: h.domains.filter((d) => watched.has(d)),
          importable: h.domains.filter(importable),
        })),
      );
    } catch (caught) {
      fail(res, caught);
    }
  });

  router.post('/:id/import', (req, res) => {
    const row = getRow(Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'No encontrado' });
      return;
    }
    const wanted = new Set<string>((Array.isArray(req.body?.domains) ? req.body.domains : []).map((d: unknown) => String(d).toLowerCase()));
    const added = importDomains(row.name, cachedHosts(row), wanted);
    res.json({ added });
  });

  /** Dominios activos de cada NPM (lo último que se supo), para reconocer su servidor por la IP. */
  /**
   * Cómo está este dominio en NPM: 'active' (activo y sin error), 'inactive' (desactivado o con la
   * configuración rota, lo que NPM enseña como «Offline»), 'absent' (no está) o null si aún no se sabe
   * nada de ningún NPM.
   */
  function npmStatus(hostname: string): 'active' | 'inactive' | 'absent' | null {
    const all = [...rows().flatMap((r) => cachedHosts(r)), ...detectedServers().flatMap((d) => d.hosts)];
    if (!all.length) return null;
    const h = hostname.toLowerCase();
    const matching = all.filter((x) => x.domains.some((d) => domainMatches(d, h)));
    if (!matching.length) return 'absent';
    return matching.some((x) => x.enabled && x.online && !x.error) ? 'active' : 'inactive';
  }

  function domainsByInstance() {
    return [
      ...rows().map((row) => ({ instance: info(row), domains: cachedHosts(row).filter((h) => h.enabled).flatMap((h) => h.domains).filter(importable) })),
      ...detectedServers().map((d) => ({ instance: detectedInfo(d), domains: d.hosts.flatMap((h) => h.domains).filter(importable) })),
    ];
  }

  return {
    router,
    findHost,
    findHosts,
    npmStatus,
    /** Otra fuente de NPM detectados (Portainer). */
    setExtraDetected(fn: typeof extraDetected) {
      extraDetected = fn;
    },
    domainsByInstance,
    instances: () => rows().map(info),
    start() {
      const tick = () => {
        for (const row of rows()) if (!row.synced_at || Date.now() - row.synced_at >= SYNC_MS) sync(row).catch(() => undefined);
      };
      setTimeout(tick, 5_000).unref();
      setInterval(tick, 60_000).unref();
      // Los detectados por el script: se espera a que lleguen las primeras métricas tras arrancar.
      setTimeout(() => importDetected(), 30_000).unref();
      setInterval(() => importDetected(), 60_000).unref();
    },
  };
}

export type NpmService = ReturnType<typeof createNpmService>;
