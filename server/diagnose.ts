/*
 * Dónde se ha caído una web.
 *
 * Se sigue el camino de una visita, paso a paso, y se marca el primero que falla:
 *   1. DNS          ¿el dominio apunta a algún sitio (y al mismo que el resto de webs de ese NPM)?
 *   2. Servidor     ¿se puede conectar al servidor por el puerto de la web? ¿el panel recibe sus métricas?
 *   3. Certificado  ¿el HTTPS es válido para este dominio?
 *   4. NPM          ¿responde Nginx Proxy Manager y tiene este dominio activo y sin errores?
 *   5. Contenedor   ¿el contenedor al que NPM manda la web está en marcha?
 *   6. Aplicación   ¿la aplicación contesta bien?
 *
 * Lo que no se puede comprobar desde el panel (por ejemplo, entrar en la red interna de otro servidor) se deduce
 * de lo que dice NPM (502/504) y de las métricas que envía cada servidor.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { ContainerInfo, Diagnosis, Monitor, RouteStep, RouteStepId, ServerStats } from '../shared/types';
import { exitCode } from '../shared/health';
import type { DB } from './db';
import type { NpmProxyHost, NpmService } from './npm';
import { readLayout } from './routes/layout';
import type { PortainerScan } from './portainerScan';
import { containerForIp, readAllStats } from './routes/stats';

const DNS_TIMEOUT_MS = 4_000;
const CONNECT_TIMEOUT_MS = 6_000;

/** Resuelve como lo hace el resto del panel (el resolvedor del sistema), con un límite de tiempo. */
async function resolve4(hostname: string): Promise<string[]> {
  const lookup = dns.promises.lookup(hostname, { family: 4, all: true }).then((r) => [...new Set(r.map((a) => a.address))]);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), DNS_TIMEOUT_MS));
  return Promise.race([lookup, timeout]);
}

function minutesAgo(ts: number) {
  const min = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
}
const dateEs = (ts: number) => new Date(ts).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' });

/** Lo que devuelve el servidor web al pedir la página, sin seguir redirecciones. */
interface Probe {
  status: number | null;
  server: string | null;
  body: string;
  latencyMs: number | null;
  error: string | null;
}

function probe(ip: string, url: URL, timeoutMs: number): Promise<Probe> {
  const isHttps = url.protocol === 'https:';
  const started = performance.now();
  return new Promise((resolve) => {
    const req = (isHttps ? https : http).request(
      {
        host: ip,
        port: Number(url.port) || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Host: url.host, 'User-Agent': 'ServerPanel-Diagnostico/1.0', Accept: 'text/html,*/*' },
        servername: isHttps ? url.hostname : undefined,
        // El certificado ya se mira en su propio paso: aquí interesa ver qué hay detrás aunque esté mal.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 20_000) body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? null,
            server: String(res.headers.server ?? '') || null,
            body,
            latencyMs: Math.round(performance.now() - started),
            error: null,
          }),
        );
        res.on('error', () => resolve({ status: res.statusCode ?? null, server: String(res.headers.server ?? '') || null, body, latencyMs: null, error: null }));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (error: NodeJS.ErrnoException) => resolve({ status: null, server: null, body: '', latencyMs: null, error: error.code || error.message }));
    req.end();
  });
}

function connect(ip: string, port: number): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port, timeout: CONNECT_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, code: 'ETIMEDOUT' });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code || 'ERROR' }));
  });
}

interface TlsResult {
  ok: boolean;
  code: string | null;
  validTo: number | null;
  issuer: string | null;
  names: string[];
}
function checkTls(ip: string, url: URL): Promise<TlsResult> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: ip,
      port: Number(url.port) || 443,
      servername: url.hostname,
      rejectUnauthorized: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const names = String(cert?.subjectaltname ?? '')
        .split(',')
        .map((n) => n.trim().replace(/^DNS:/, ''))
        .filter(Boolean);
      const identity = cert && Object.keys(cert).length ? tls.checkServerIdentity(url.hostname, cert) : new Error('sin certificado');
      const code = socket.authorizationError ? String((socket.authorizationError as any).code ?? socket.authorizationError) : identity ? 'ERR_TLS_CERT_ALTNAME_INVALID' : null;
      socket.destroy();
      resolve({
        ok: !code,
        code,
        validTo: cert?.valid_to ? Date.parse(cert.valid_to) : null,
        issuer: cert?.issuer ? String(cert.issuer.O || cert.issuer.CN || '') || null : null,
        names,
      });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, code: 'ETIMEDOUT', validTo: null, issuer: null, names: [] });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, code: error.code || error.message, validTo: null, issuer: null, names: [] }));
  });
}

/** La página por defecto de NPM cuando le llega un dominio que no tiene configurado. */
/** La página que enseña NPM a un dominio que no tiene configurado (no su propia web de administración). */
const looksLikeNpmDefault = (p: Probe) => /congratulations!|you've successfully started the nginx proxy manager/i.test(p.body);
const isNpmServer = (p: Probe) => /openresty/i.test(p.server ?? '');

const PRIVATE_GATEWAY = /^(127\.|localhost$|host\.docker\.internal$|172\.(1[6-9]|2\d|3[01])\.\d+\.1$)/i;
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** Un puerto de `docker ps`: «0.0.0.0:3004->3000/tcp», «[::]:3000-3002->3000-3002/tcp» o solo «80/tcp». */
interface PortMap {
  host: [number, number] | null;
  inside: [number, number];
}
function parsePorts(text: string | null | undefined): PortMap[] {
  const out: PortMap[] = [];
  for (const part of (text ?? '').split(',')) {
    const m = part.trim().match(/^(?:.*:(\d+)(?:-(\d+))?->)?(\d+)(?:-(\d+))?\/(?:tcp|udp|sctp)$/i);
    if (!m) continue;
    const host: [number, number] | null = m[1] ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
    out.push({ host, inside: [Number(m[3]), Number(m[4] ?? m[3])] });
  }
  return out;
}
const inRange = (port: number, [a, b]: [number, number]) => port >= a && port <= b;
/** Publica ese puerto en la máquina (lo que hay a la izquierda de «->»). */
const publishes = (c: ContainerInfo, port: number) => parsePorts(c.ports).some((p) => p.host && inRange(port, p.host));
/** Escucha en ese puerto por dentro (lo que hay a la derecha de «->», o los puertos expuestos). */
const listensOn = (c: ContainerInfo, port: number) => parsePorts(c.ports).some((p) => inRange(port, p.inside));

/** Cómo se ha encontrado el contenedor, para explicarlo en la ficha. */
type FoundBy = 'name' | 'alias' | 'guess' | 'ip' | 'ip-memory' | 'port' | 'self';

/** Palabras de un nombre de contenedor o de una web, para ver si dos son la misma aplicación. */
const COMMON = new Set(['app', 'web', 'www', 'com', 'es', 'net', 'org', 'api', 'server', 'service', 'prod', 'main', 'default', 'docker']);
function words(name: string | null | undefined): string[] {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !COMMON.has(t) && !/^\d+$/.test(t));
}
/** La parte propia de un dominio («salsanova» en salsanova.app, «facturas» en facturas.midominio.com). */
function siteWords(hostname: string): string[] {
  const labels = hostname.toLowerCase().split('.');
  return words(labels.length > 2 ? labels.slice(0, -2).join(' ') : labels[0]);
}
const overlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => x === y || x.includes(y) || y.includes(x)));
/** ¿Parece la misma aplicación? (comparte palabras con el contenedor principal o con la web) */
export function sameApp(candidate: string, main: string | null, hostname: string): boolean {
  const c = words(candidate);
  return overlap(c, words(main)) || overlap(c, siteWords(hostname));
}
/** En esa máquina, un contenedor que parezca de esta web y escuche en ese puerto (para sugerirlo). */
export function similarContainer(server: ServerStats, hostname: string, port: number, not: ContainerInfo, main?: string | null): ContainerInfo | null {
  const want = [...siteWords(hostname), ...words(main)];
  return server.containers.find((c) => c.name !== not.name && c.state === 'running' && overlap(words(c.name), want) && listensOn(c, port)) ?? null;
}

/** De varios candidatos, el que escucha en el puerto de destino y, si no, el que está en marcha. */
function best(list: ContainerInfo[], port: number): ContainerInfo {
  const score = (c: ContainerInfo) => (listensOn(c, port) ? 2 : 0) + (c.state === 'running' ? 1 : 0);
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

/** Lo que se sabe de las IPs alrededor del destino. */
interface TargetHints {
  /** IPs públicas por las que se llega al NPM (la de la web y las de sus otras webs). */
  selfIps?: string[];
  /** IPs públicas de otras máquinas del panel deducidas de los destinos de NPM (IP → serverId). */
  publicIps?: Map<string, string>;
  /** IPs a las que resuelve el destino, si es un nombre de dominio («casa.midominio.com»). */
  resolved?: string[];
  /** De quién era una IP interna de Docker la última vez que se vio (un contenedor parado ya no la tiene). */
  rememberIp?: (serverId: string, ip: string) => string | null;
  /** El proxy está instalado en la máquina (Apache), no en un contenedor: 127.0.0.1 es la propia máquina. */
  native?: boolean;
}

/** «Apache» si el proxy es un Apache instalado en la máquina; si no, «NPM». */
const proxyWord = (instanceName: string) => (/^Apache\b/.test(instanceName) ? 'Apache' : 'NPM');

/** El contenedor de Nginx Proxy Manager en una máquina. */
const isNpmContainer = (c: ContainerInfo) => /nginx-proxy-manager|npmplus|nginxproxymanager|jc21\/nginx/i.test(`${c.image ?? ''} ${c.name}`);

/**
 * IPs públicas que no salen en `hostname -I` (en Oracle la IP pública está fuera, por NAT). Si varios
 * destinos de NPM van a la misma IP pública y en una máquina del panel hay contenedores que publican
 * esos puertos, esa IP es de esa máquina (esté NPM en ella o en otra).
 */
export function learnPublicIps(hosts: NpmProxyHost[], statsList: ServerStats[]): Map<string, string> {
  const byIp = new Map<string, number[]>();
  for (const h of hosts) {
    const ip = h.forwardHost.trim();
    if (!net.isIPv4(ip) || PRIVATE_IP.test(ip) || statsList.some((s) => s.ips.includes(ip))) continue;
    byIp.set(ip, [...(byIp.get(ip) ?? []), h.forwardPort]);
  }
  const out = new Map<string, string>();
  for (const [ip, ports] of byIp) {
    let bestId: string | null = null;
    let bestHits = 0;
    for (const s of statsList) {
      const hits = ports.filter((port) => s.containers.some((c) => publishes(c, port))).length;
      if (hits > bestHits) [bestId, bestHits] = [s.serverId, hits];
    }
    if (bestId && bestHits >= 2 && bestHits / ports.length >= 0.5) out.set(ip, bestId);
  }
  return out;
}

/**
 * Busca el contenedor que hay detrás del destino de NPM, como lo resolvería el propio NPM:
 *   · un nombre lo resuelve el DNS de Docker en la máquina de NPM: nombre del contenedor, servicio del
 *     stack o alias de red (con el puerto de dentro del contenedor);
 *   · una IP de una red de Docker es la de un contenedor concreto;
 *   · 127.0.0.1 dentro de NPM es el propio NPM;
 *   · una IP de una máquina (también su IP pública o la puerta de enlace de Docker) lleva al
 *     contenedor que publica ese puerto.
 * Nunca se adivina por el puerto cuando NPM apunta a un nombre: el puerto es el de dentro y puede
 * coincidir con el que publica otro contenedor (con el 80, el propio NPM).
 * `external` indica que el destino es otra máquina que el panel no conoce (p. ej. tu casa).
 */
export function findTarget(host: NpmProxyHost, npmServerId: string | null, statsList: ServerStats[], hints: TargetHints = {}) {
  const target = host.forwardHost.trim().toLowerCase().replace(/\.$/, '');
  const port = host.forwardPort;
  const npmServer = statsList.find((s) => s.serverId === npmServerId);
  const ordered = npmServer ? [npmServer, ...statsList.filter((s) => s !== npmServer)] : statsList;
  const none = { server: undefined as ServerStats | undefined, container: undefined as ContainerInfo | undefined, foundBy: null as FoundBy | null, external: false, ip: null as string | null };
  const found = (server: ServerStats, list: ContainerInfo[], foundBy: FoundBy, ip: string | null = null) =>
    list.length ? { ...none, server, container: best(list, port), foundBy, ip } : { ...none, server, ip };

  // Una IP: la de un contenedor en la red de Docker de NPM, o la de una máquina (el que publica ese puerto).
  const byMachineIp = (ip: string) => {
    // Las IPs internas de Docker solo existen en la máquina de NPM (en otra pueden repetirse y ser otro).
    const internal = PRIVATE_IP.test(ip) && !PRIVATE_GATEWAY.test(ip) && !statsList.some((s) => s.ips.includes(ip));
    for (const s of internal && npmServer ? [npmServer] : ordered) {
      const live = s.containers.filter((x) => x.ips?.includes(ip));
      if (live.length) return found(s, live, 'ip', ip);
      const remembered = hints.rememberIp?.(s.serverId, ip);
      const stopped = remembered ? s.containers.filter((x) => x.name === remembered && !x.ips?.length) : [];
      if (stopped.length) return found(s, stopped, 'ip-memory', ip);
    }
    const ownerId = hints.publicIps?.get(ip);
    const server =
      statsList.find((s) => s.ips.includes(ip)) ??
      (ownerId ? statsList.find((s) => s.serverId === ownerId) : undefined) ??
      (PRIVATE_GATEWAY.test(ip) || hints.selfIps?.includes(ip) ? npmServer : undefined);
    if (!server) {
      // Una IP de la misma red local que la máquina del proxy (192.168.1.x) que no es de ningún contenedor:
      // es otro equipo de la red que el panel no tiene.
      const lan = (a: string) => a.split('.').slice(0, 3).join('.');
      if (npmServer && npmServer.ips.some((own) => net.isIPv4(own) && !/^172\.(1[6-9]|2\d|3[01])\./.test(own) && lan(own) === lan(ip))) {
        return { ...none, external: true, ip };
      }
      return internal && npmServer ? { ...none, server: npmServer, ip } : null;
    }
    return found(server, server.containers.filter((c) => publishes(c, port)), 'port', ip);
  };

  // Dentro del contenedor de NPM, 127.0.0.1 es el propio NPM; en un Apache instalado en la máquina, la máquina.
  if ((/^127\./.test(target) || target === 'localhost') && hints.native && npmServer) {
    return found(npmServer, npmServer.containers.filter((c) => publishes(c, port)), 'port');
  }
  if (/^127\./.test(target) || target === 'localhost') {
    if (npmServer) {
      const self = npmServer.containers.filter(isNpmContainer);
      if (self.length) return found(npmServer, self, 'self');
      return found(npmServer, npmServer.containers.filter((c) => publishes(c, port)), 'port');
    }
    return none;
  }
  if (net.isIP(target) || target === 'host.docker.internal') {
    return byMachineIp(target === 'host.docker.internal' ? '172.17.0.1' : target) ?? { ...none, external: !PRIVATE_IP.test(target), ip: target };
  }

  // Un nombre: primero donde está NPM (es quien lo resuelve); si no se sabe dónde está, en todos.
  for (const s of npmServer ? [npmServer] : statsList) {
    const lower = (c: ContainerInfo) => c.name.toLowerCase();
    const exact = s.containers.filter((c) => lower(c) === target);
    if (exact.length) return found(s, exact, 'name');
    const alias = s.containers.filter((c) => c.aliases?.some((a) => a.toLowerCase() === target));
    if (alias.length) return found(s, alias, 'alias');
    // Sin alias (script antiguo): los nombres que pone Docker Compose o Swarm a partir del servicio.
    const guess = s.containers.filter((c) => {
      const n = lower(c);
      return n.endsWith(`-${target}-1`) || n.endsWith(`_${target}_1`) || n === `${target}-1` || n === `${target}_1` || n.startsWith(`${target}.`);
    });
    if (guess.length) return found(s, guess, 'guess');
  }
  // El nombre de otra máquina del panel (p. ej. «raspberrypi»).
  const short = target.split('.')[0];
  const machine = statsList.find((s) => s.hostname && (s.hostname.toLowerCase() === target || s.hostname.toLowerCase().split('.')[0] === short));
  if (machine) return found(machine, machine.containers.filter((c) => publishes(c, port)), 'port');
  // Un dominio («casa.midominio.com»): a dónde apunta.
  for (const ip of hints.resolved ?? []) {
    const r = byMachineIp(ip);
    if (r) return r;
  }
  if (target.includes('.')) return { ...none, external: true, ip: hints.resolved?.[0] ?? null };
  return npmServer ? { ...none, server: npmServer } : none;
}

const STEP_TITLE: Record<RouteStepId, string> = {
  dns: 'Falla el DNS',
  server: 'Falla el servidor',
  tls: 'Falla el certificado',
  proxy: 'Falla Nginx Proxy Manager',
  container: 'Falla el contenedor',
  app: 'Falla la aplicación',
};

export function createDiagnoser(db: DB, npm: NpmService, portainer?: PortainerScan) {
  return async function diagnose(monitor: Monitor): Promise<Diagnosis> {
    const url = new URL(monitor.url);
    const hostname = url.hostname;
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port) || (isHttps ? 443 : 80);
    // Lo que envían los scripts, completado con lo que se ve en Portainer (contenedores, redes, puertos).
    // Cada máquina se reconoce también por la IP que tiene puesta en el esquema (192.168.1.20, 82.70.78.105…).
    const statsList = (portainer ? portainer.enrich(readAllStats(db)) : readAllStats(db)).map((s) => {
      const extra = readLayout(db)
        .layout.nodes.filter((n) => n.serverId === s.serverId && n.ip && net.isIP(n.ip.trim()))
        .map((n) => n.ip!.trim());
      return extra.length ? { ...s, ips: [...new Set([...s.ips, ...extra])] } : s;
    });
    const layoutNodes = readLayout(db).layout.nodes;
    const serverName = (id: string | null | undefined) =>
      (id && (layoutNodes.find((n) => n.serverId === id)?.title || statsList.find((s) => s.serverId === id)?.hostname)) || id || 'el servidor';
    const endpointOf = (id: string) =>
      layoutNodes.find((n) => n.serverId === id && n.portainerEndpointId)?.portainerEndpointId ?? portainer?.endpointOf(id) ?? null;

    const matches = await npm.findHosts(hostname).catch(() => [] as Awaited<ReturnType<NpmService['findHosts']>>);
    type Match = (typeof matches)[number];
    const statsOf = (m: Match) => statsList.find((s) => s.serverId === m.instance.serverId);
    // Con dos NPM para el mismo dominio (uno fuera que lo manda a casa y otro en casa que lo manda al
    // contenedor), la visita entra por el que manda a otra máquina y sigue por el otro.
    let match: Match | null = matches[0] ?? null;
    let nextHop: Match | null = null;
    if (matches.length > 1) {
      const outer = matches.find((m) => findTarget(m.host, m.instance.serverId, statsList).external);
      if (outer) {
        match = outer;
        nextHop = matches.find((m) => m !== outer && m.instance.serverId !== outer.instance.serverId) ?? null;
      } else if (!net.isIP(hostname)) {
        // Si no, el NPM de la máquina a la que apunta el DNS de la web.
        const ips = await resolve4(hostname).catch(() => [] as string[]);
        const owner = (m: Match) => {
          const publicIps = learnPublicIps(m.all, statsList);
          return ips.some((ip) => statsOf(m)?.ips.includes(ip) || publicIps.get(ip) === m.instance.serverId);
        };
        match = matches.find(owner) ?? match;
      }
    }
    /** IPs por las que se llega a este NPM desde fuera (la de la web y la de sus otras webs). */
    let entryIps: string[] = [];
    // Si el dominio no está en ningún NPM, se intenta saber al menos a qué servidor llega (por la IP de las demás webs).
    let guessedServerId: string | null = null;
    let guessedNpm: string | null = null;
    const npmServerId = () => match?.instance.serverId ?? guessedServerId;
    const npmServer = () => (npmServerId() ? statsList.find((s) => s.serverId === npmServerId()) : undefined);
    const npmServerName = () => (npmServerId() ? serverName(npmServerId()) : null);

    const steps: RouteStep[] = [];
    let action: Diagnosis['action'] = null;
    const add = (id: RouteStepId, label: string, status: RouteStep['status'], detail: string) => steps.push({ id, label, status, detail });
    const skipRest = (from: RouteStepId[]) => {
      const labels: Record<RouteStepId, string> = {
        dns: 'DNS',
        server: npmServerName() ?? 'Servidor',
        tls: 'Certificado',
        proxy: match?.instance.name ?? guessedNpm ?? 'Nginx Proxy Manager',
        container: match ? `${match.host.forwardHost}:${match.host.forwardPort}` : 'Contenedor',
        app: 'Aplicación',
      };
      for (const id of from) if (!steps.some((s) => s.id === id) && (id !== 'tls' || isHttps)) add(id, labels[id], 'skip', 'No se llega hasta aquí.');
    };

    /* 1. DNS */
    let ip = hostname;
    if (net.isIP(hostname)) {
      add('dns', 'DNS', 'ok', 'La web usa una IP directa.');
    } else {
      try {
        const ips = await resolve4(hostname);
        ip = ips[0];
        // ¿Apunta al mismo sitio que las demás webs de ese NPM?
        let expected: string | null = null;
        if (match?.siblings.length) {
          const counts = new Map<string, number>();
          for (const d of match.siblings.filter((d) => !d.includes('*')).slice(0, 4)) {
            const other = await resolve4(d).catch(() => [] as string[]);
            if (other[0]) counts.set(other[0], (counts.get(other[0]) ?? 0) + 1);
          }
          expected = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        }
        if (!match) {
          for (const { instance, domains } of npm.domainsByInstance()) {
            if (!instance.serverId) continue;
            for (const d of domains.slice(0, 2)) {
              const other = await resolve4(d).catch(() => [] as string[]);
              if (other.some((o) => ips.includes(o))) {
                guessedServerId = instance.serverId;
                guessedNpm = instance.name;
              }
            }
            if (guessedServerId) break;
          }
        }
        entryIps = [...new Set([...ips, ...(expected ? [expected] : [])])];
        if (expected && !ips.includes(expected)) {
          add('dns', 'DNS', 'warn', `Apunta a ${ips.join(', ')}, pero tus otras webs de ${match!.instance.name} están en ${expected}. ¿Ha cambiado la IP o falta actualizar el registro en Cloudflare?`);
        } else {
          add('dns', 'DNS', 'ok', `${hostname} → ${ips.join(', ')}`);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const detail =
          code === 'ENOTFOUND' || code === 'ENODATA'
            ? `${hostname} no tiene registro A: el dominio no existe, ha caducado o falta el registro en Cloudflare.`
            : code === 'ETIMEOUT' || code === 'EAI_AGAIN' || code === 'ESERVFAIL' || code === 'ECONNREFUSED'
              ? 'Los servidores DNS no responden ahora mismo.'
              : `No se pudo resolver el dominio (${code ?? 'error'}).`;
        add('dns', 'DNS', 'fail', detail);
        skipRest(['server', 'tls', 'proxy', 'container', 'app']);
        return finish();
      }
    }

    /* 2. Servidor: llegar por red al puerto de la web */
    const serverLabel = npmServerName() ?? ip;
    const reach = await connect(ip, port);
    if (!reach.ok && reach.code !== 'ECONNREFUSED') {
      let detail: string;
      if (npmServer() && !npmServer()!.online) {
        detail = `${serverLabel} no envía datos al panel desde hace ${minutesAgo(npmServer()!.lastUpdated)}: está apagado, colgado o sin conexión.`;
      } else if (npmServer()) {
        detail = `${serverLabel} funciona (sigue enviando datos al panel), pero desde fuera no se llega al puerto ${port}: revisa el firewall o las reglas de seguridad del proveedor.`;
      } else {
        detail = `No se puede conectar con ${ip} por el puerto ${port} (${reach.code === 'ETIMEDOUT' ? 'no contesta' : reach.code}): el servidor está caído o un firewall lo bloquea.`;
      }
      add('server', serverLabel, 'fail', detail);
      skipRest(['tls', 'proxy', 'container', 'app']);
      return finish();
    }
    if (!reach.ok) {
      // Conexión rechazada: la máquina contesta, pero no hay nada escuchando en el puerto (NPM caído).
      add('server', serverLabel, 'ok', `${ip} responde, pero nada escucha en el puerto ${port}.`);
      const npmContainer = npmServer()?.containers.find((c) => /nginx-proxy-manager|jc21\/nginx/i.test(`${c.image ?? ''} ${c.name}`));
      let detail = `Nginx Proxy Manager no está escuchando en el puerto ${port}: su contenedor está parado o no publica ese puerto.`;
      if (npmContainer && npmContainer.state !== 'running') {
        const code = exitCode(npmContainer);
        detail = `El contenedor de Nginx Proxy Manager (${npmContainer.name}) está ${npmContainer.state === 'exited' ? 'parado' : npmContainer.state}${code ? ` (código ${code})` : ''} en ${serverLabel}.`;
        const endpointId = npmServerId() ? endpointOf(npmServerId()!) : null;
        if (endpointId) action = { kind: 'start-container', endpointId, container: npmContainer.name, serverName: serverLabel };
      }
      add('proxy', match?.instance.name ?? guessedNpm ?? 'Nginx Proxy Manager', 'fail', detail);
      skipRest(['tls', 'container', 'app']);
      return finish();
    }
    add('server', serverLabel, 'ok', npmServer()?.online === false ? `Responde en el puerto ${port} (aunque no envía métricas desde hace ${minutesAgo(npmServer()!.lastUpdated)}).` : `Responde en el puerto ${port}.`);

    /* 3. Certificado */
    let tlsProblem: string | null = null;
    if (isHttps) {
      const t = await checkTls(ip, url);
      if (t.ok) {
        const days = t.validTo ? Math.floor((t.validTo - Date.now()) / 86_400_000) : null;
        add('tls', 'Certificado', days !== null && days < 7 ? 'warn' : 'ok', `Válido hasta el ${t.validTo ? dateEs(t.validTo) : '¿?'}${t.issuer ? ` (${t.issuer})` : ''}${days !== null && days < 7 ? `: caduca en ${days} días` : ''}.`);
      } else {
        const c = t.code ?? '';
        tlsProblem =
          c === 'CERT_HAS_EXPIRED'
            ? `El certificado caducó el ${t.validTo ? dateEs(t.validTo) : '¿?'}: NPM no ha podido renovarlo (Let's Encrypt).`
            : c === 'ERR_TLS_CERT_ALTNAME_INVALID'
              ? `El certificado que se sirve no es de ${hostname}${t.names.length ? ` (es de ${t.names.slice(0, 2).join(', ')})` : ''}: NPM no tiene certificado para este dominio o el host está desactivado.`
              : /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(c)
                ? 'El certificado no es de confianza (autofirmado o incompleto): suele pasar cuando NPM no tiene un certificado para este dominio.'
                : c === 'ETIMEDOUT'
                  ? 'El servidor no completa la conexión segura (HTTPS).'
                  : `No se puede establecer la conexión segura (${c}).`;
        add('tls', 'Certificado', 'fail', tlsProblem);
      }
    }

    /* 4. Nginx Proxy Manager */
    const p = await probe(ip, url, monitor.timeoutMs);
    const proxyLabel = match?.instance.name ?? guessedNpm ?? (p.server && isNpmServer(p) ? 'Nginx Proxy Manager' : 'Proxy');
    if (p.status === null) {
      add('proxy', proxyLabel, 'fail', p.error === 'ETIMEDOUT' ? `Acepta la conexión, pero no contesta en ${Math.round(monitor.timeoutMs / 1000)} s: Nginx Proxy Manager está colgado o el servidor va muy cargado.` : `La conexión se corta sin respuesta (${p.error}).`);
      skipRest(['container', 'app']);
      return finish();
    }
    if (match && !match.host.enabled) {
      add('proxy', proxyLabel, 'fail', `${hostname} está desactivado en ${match.instance.name}. Actívalo en Proxy Hosts.`);
      skipRest(['container', 'app']);
      return finish();
    }
    if (match && !match.host.online) {
      add('proxy', proxyLabel, 'fail', `${match.instance.name} tiene un error en la configuración de este host${match.host.error ? `: ${match.host.error.replace(/\.$/, '')}` : ''}.`);
      skipRest(['container', 'app']);
      return finish();
    }
    if (looksLikeNpmDefault(p) || (!match && isNpmServer(p) && p.status === 404)) {
      add('proxy', proxyLabel, 'fail', `${guessedNpm ?? 'Nginx Proxy Manager'} recibe la visita, pero no tiene ${hostname} configurado o está desactivado (sale su página por defecto). Revisa el proxy host en NPM.`);
      skipRest(['container', 'app']);
      return finish();
    }
    const npmGateway = (isNpmServer(p) || /apache/i.test(p.server ?? '')) && (p.status === 502 || p.status === 503 || p.status === 504);
    // La configuración avanzada puede mandar la portada a otro destino distinto del de la ficha.
    const root = match?.host.root ?? null;
    const card = match ? `${match.host.forwardScheme}://${match.host.forwardHost}:${match.host.forwardPort}` : null;
    const forward = root ? `${root.scheme}://${root.host}:${root.port}` : card;
    add(
      'proxy',
      proxyLabel,
      'ok',
      match
        ? root
          ? `Tiene ${hostname} activo. Su configuración avanzada manda la portada a ${forward} (el destino de la ficha, ${card}, no se usa para ella).`
          : `Tiene ${hostname} activo y lo manda a ${forward}.`
        : isNpmServer(p)
          ? 'Responde (no está en ningún NPM que conozca el panel, así que no sé a dónde lo manda).'
          : `Responde (${p.server || 'servidor web'}).`,
    );

    /* 5. Contenedor de destino */
    let containerRunning: ContainerInfo | undefined;
    if (match) {
      // Dónde acaba un salto de NPM (los dominios de destino se resuelven, como haría NPM).
      const locate = async (m: Match, selfIps: string[]) => {
        const fwd = m.host.forwardHost.trim().toLowerCase();
        const resolved = !net.isIP(fwd) && fwd.includes('.') ? await resolve4(fwd).catch(() => [] as string[]) : [];
        return findTarget(m.host, m.instance.serverId, statsList, {
          native: proxyWord(m.instance.name) === 'Apache',
          selfIps,
          publicIps: learnPublicIps(m.all, statsList),
          resolved,
          rememberIp: (serverId, ip) => containerForIp(db, serverId, ip),
        });
      };
      /** El salto tal como va de verdad la portada (configuración avanzada incluida). */
      const routed = (m: Match): Match =>
        m.host.root ? { ...m, host: { ...m.host, forwardScheme: m.host.root.scheme, forwardHost: m.host.root.host, forwardPort: m.host.root.port, root: null } } : m;
      const destOf = (m: Match) => `${routed(m).host.forwardHost}:${routed(m).host.forwardPort}`;
      const locateRouted = (m: Match, selfIps: string[]) => locate(routed(m), selfIps);
      let hop: Match = match;
      let found = await locateRouted(match, entryIps);
      let via = '';
      if (!found.container && found.external) {
        // Va a otra máquina: si allí hay otro NPM que el panel conoce con este dominio, se sigue por él.
        const next = nextHop ?? matches.find((m) => m !== match && m.instance.serverId !== match!.instance.serverId) ?? null;
        if (next) {
          const second = await locateRouted(next, found.ip ? [found.ip] : []);
          if (second.container || second.server) {
            via = ` Pasa por ${destOf(match)}, donde ${proxyWord(next.instance.name) === 'Apache' ? 'el Apache' : 'el Nginx Proxy Manager'} de ${next.instance.serverId ? serverName(next.instance.serverId) : next.instance.name} lo manda a ${destOf(next)}.`;
            hop = next;
            found = second;
          }
        }
      }
      const { server, container, foundBy } = found;
      const dest = destOf(hop);
      /** «NPM» o «Apache», según el proxy de este salto. */
      const px = proxyWord(hop.instance.name);
      const hopHost = routed(hop).host;
      const label = container?.name ?? (found.external ? hopHost.forwardHost : dest);

      // Avisos: una IP fija de NPM que Docker ha dado a otro contenedor, y el respaldo de la configuración avanzada.
      const warnings: string[] = [];
      const port = hopHost.forwardPort;
      if (container && foundBy === 'ip' && container.state === 'running') {
        const self = isNpmContainer(container) && !/^127\.|^localhost$/.test(hopHost.forwardHost);
        if (self || (container.ports && !listensOn(container, port))) {
          const better = server ? similarContainer(server, hostname, port, container) : null;
          warnings.push(
            `Ojo: ${hopHost.forwardHost} es ahora la IP de ${container.name}${self ? ', el propio Nginx Proxy Manager' : `, que no escucha en el ${port}`}. Docker cambia las IPs al reiniciar los contenedores${
              better ? `; ${better.name} está ahora en ${better.ips?.[0] ?? '?'}` : ''
            }. En NPM pon el nombre del contenedor${better ? ` (${better.name}:${port})` : ''} en lugar de la IP.`,
          );
        }
      }
      const fb = match.host.fallback;
      if (fb) {
        const fbMatch: Match = { ...match, host: { ...match.host, forwardScheme: fb.scheme, forwardHost: fb.host, forwardPort: fb.port, root: null, fallback: null } };
        const r = await locate(fbMatch, entryIps);
        const fbDest = `${fb.host}:${fb.port}`;
        if (r.container) {
          if (sameApp(r.container.name, container?.name ?? null, hostname)) {
            warnings.push(`Respaldo si falla: ${fbDest} → ${r.container.name} en ${serverName(r.server?.serverId)}${r.container.state === 'running' ? '' : ' (parado)'}.`);
          } else {
            const better = r.server ? similarContainer(r.server, hostname, fb.port, r.container, container?.name) : null;
            warnings.push(
              `Ojo con el respaldo: ${fbDest} lleva ahora a ${r.container.name} en ${serverName(r.server?.serverId)}, que no parece la misma aplicación${
                better ? ` (${better.name} está ahora en ${better.ips?.[0] ?? '?'})` : ''
              }. Si el destino principal falla, saldría otra web. En el respaldo pon el nombre del contenedor${better ? ` (${better.name}:${fb.port})` : ''} en lugar de la IP.`,
            );
          }
        } else if (!r.external) {
          warnings.push(`Ojo con el respaldo: ${fbDest} no lleva a ningún contenedor que el panel conozca.`);
        }
      }
      const notes = warnings.length ? ` ${warnings.join(' ')}` : '';
      const hasWarning = warnings.some((w) => w.startsWith('Ojo'));
      // Por qué es este contenedor, cuando NPM no apunta a su nombre tal cual.
      const why =
        via ||
        (!container || foundBy === 'name'
          ? ''
          : foundBy === 'alias'
            ? ` ${px} apunta a ${dest}, que es su nombre en la red de Docker.`
            : foundBy === 'ip'
              ? ` ${px} apunta a ${dest}, su IP en la red de Docker.`
              : foundBy === 'ip-memory'
                ? ` ${px} apunta a ${dest}: era su IP en la red de Docker (al pararse, Docker se la quita).`
              : foundBy === 'self'
                ? ` ${px} apunta a ${dest}: es el propio Nginx Proxy Manager.`
                : foundBy === 'port'
                  ? ` ${px} apunta a ${dest} y es el contenedor que publica ese puerto${found.ip && !server?.ips.includes(found.ip) && !PRIVATE_IP.test(found.ip) ? ` (${found.ip} es la IP pública de ${serverName(server?.serverId)})` : ''}.`
                  : ` ${px} apunta a ${dest} (deducido por el nombre; actualiza el script de métricas para saberlo seguro).`);
      if (container && container.state !== 'running') {
        const code = exitCode(container);
        const where = serverName(server?.serverId);
        const state =
          container.state === 'exited'
            ? `parado${code ? ` con error (código ${code})` : ''}`
            : container.state === 'restarting'
              ? 'reiniciándose sin parar'
              : container.state === 'paused'
                ? 'en pausa'
                : container.state === 'created'
                  ? 'creado pero sin arrancar'
                  : container.state === 'dead'
                    ? 'muerto (Docker no pudo pararlo bien)'
                    : container.state;
        add('container', label, 'fail', `${container.name} está ${state} en ${where}${container.status ? ` · ${container.status}` : ''}.${why}${notes}`);
        const endpointId = server ? endpointOf(server.serverId) : null;
        if (endpointId) action = { kind: 'start-container', endpointId, container: container.name, serverName: where };
        skipRest(['app']);
        return finish();
      }
      if (container) {
        containerRunning = container;
        add('container', label, hasWarning ? 'warn' : 'ok', `En marcha en ${serverName(server?.serverId)}${container.status ? ` · ${container.status}` : ''}.${why}${notes}`);
      } else if (server && !server.online) {
        add('container', label, 'fail', `${serverName(server.serverId)}, donde está ${hop.host.forwardHost}, no envía datos desde hace ${minutesAgo(server.lastUpdated)}: está apagado o sin red.${via}`);
        skipRest(['app']);
        return finish();
      } else {
        const byAddress = net.isIP(hop.host.forwardHost.trim()) > 0 || found.ip !== null;
        const old = server && !server.containers.some((c) => c.aliases || c.ips);
        add(
          'container',
          label,
          npmGateway ? 'warn' : 'skip',
          found.external
            ? `${px} lo manda a ${dest}${found.ip && found.ip !== hopHost.forwardHost ? ` (${found.ip})` : ''}, otra máquina que el panel no ve. Si allí hay otro proxy (Nginx Proxy Manager o Apache), con el script de métricas actualizado en esa máquina el panel seguirá la ruta hasta el contenedor.`
            : server
              ? byAddress
                ? `${px} lo manda a ${dest}. En ${serverName(server.serverId)} ningún contenedor ${old ? 'publica ese puerto (actualiza allí el script de métricas para que envíe las IPs de cada contenedor)' : 'tiene esa IP ni publica ese puerto: será un servicio de la propia máquina'}.${via}`
                : `${px} lo manda a ${dest}, pero en ${serverName(server.serverId)} no hay ningún contenedor con ese nombre o alias${old ? ' (actualiza allí el script de métricas para que envíe los nombres de red de cada contenedor)' : ''}.${via}`
              : `${hop.host.forwardHost} no es de ningún servidor del panel${hop.instance.serverId ? '' : ' (indica en qué servidor está este NPM)'}.`,
        );
      }
    } else {
      add(
        'container',
        'Contenedor',
        'skip',
        npm.domainsByInstance().length
          ? `${hostname} no está en ningún Nginx Proxy Manager conocido, así que no sé qué contenedor hay detrás.`
          : portainer && portainer.scans().length
            ? `No encuentro Nginx Proxy Manager en ningún entorno de Portainer (${portainer.scans().map((sc) => sc.name).join(', ')}) ni en los scripts de métricas, así que no sé qué contenedor hay detrás.`
            : 'Aún no sé qué contenedor hay detrás: conecta Portainer al panel o actualiza el script de métricas en el servidor donde está Nginx Proxy Manager.',
      );
    }

    /* 6. Aplicación */
    if (npmGateway) {
      const what = p.status === 504 ? 'tarda demasiado en contestar' : 'no contesta';
      const fresh = containerRunning && /up (less than|[0-9]+ seconds|about a minute)/i.test(containerRunning.status ?? '');
      add(
        'app',
        'Aplicación',
        'fail',
        containerRunning
          ? fresh
            ? `${containerRunning.name} acaba de arrancar (${containerRunning.status}) y aún ${what}: espera unos segundos.`
            : `${containerRunning.name} está en marcha pero ${what} en el puerto ${match?.host.forwardPort} (NPM da ${p.status}): la aplicación ha fallado por dentro, se ha quedado colgada o escucha en otro puerto. Mira sus logs.`
          : `Nginx Proxy Manager no consigue hablar con ${forward ?? 'el destino'} (da ${p.status}): el contenedor está parado, colgado o en otro puerto.`,
      );
      return finish();
    }
    if (p.status >= 500) {
      add('app', 'Aplicación', 'fail', `La aplicación responde con un error ${p.status}: ha fallado por dentro (mira sus logs).`);
      return finish();
    }
    if (p.status >= 400) {
      // 401/403/404/405 los da la propia aplicación: está viva (pide acceso, o es una API sin portada).
      const alive = [401, 403, 404, 405].includes(p.status);
      add(
        'app',
        'Aplicación',
        alive ? 'ok' : 'fail',
        `Responde ${p.status} en ${p.latencyMs ?? '?'} ms${
          p.status === 404
            ? ': la portada no existe, pero la aplicación contesta (normal en una API)'
            : p.status === 401 || p.status === 403
              ? ': pide acceso'
              : p.status === 405
                ? ': no admite una visita normal (normal en una API)'
                : ''
        }.`,
      );
      return finish();
    }
    if (monitor.keyword && p.status < 300 && !p.body.includes(monitor.keyword)) {
      add('app', 'Aplicación', 'fail', `Responde ${p.status}, pero la página no contiene «${monitor.keyword}».`);
      return finish();
    }
    add('app', 'Aplicación', 'ok', `Responde ${p.status}${p.status >= 300 ? ` (redirige a ${p.status === 301 || p.status === 302 || p.status === 307 || p.status === 308 ? 'otra dirección' : '…'})` : ''} en ${p.latencyMs ?? '?'} ms.`);
    return finish();

    function finish(): Diagnosis {
      const order: RouteStepId[] = ['dns', 'server', 'tls', 'proxy', 'container', 'app'];
      steps.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const failed = steps.find((s) => s.status === 'fail');
      // Un certificado mal pero la web detrás funcionando: la culpa es del certificado.
      const failedAt = failed?.id ?? null;
      let title: string;
      let summary: string;
      if (failed) {
        title = failed.id === 'server' ? `Falla el servidor ${failed.label}` : failed.id === 'container' ? `Falla el contenedor ${failed.label}` : STEP_TITLE[failed.id];
        summary = failed.detail;
      } else {
        title = 'La ruta completa funciona';
        summary = monitor.status === 'down' ? 'Ahora mismo responde bien: puede haber sido un corte momentáneo o algo intermitente.' : 'Todos los pasos responden bien.';
      }
      return { at: Date.now(), ok: !failed, failedAt, title, summary, steps, action };
    }
  };
}
