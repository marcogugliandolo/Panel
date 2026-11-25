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
import { readAllStats } from './routes/stats';

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
const looksLikeNpmDefault = (p: Probe) => /nginx proxy manager|congratulations!|you've successfully started the nginx/i.test(p.body);
const isNpmServer = (p: Probe) => /openresty/i.test(p.server ?? '');

const PRIVATE_GATEWAY = /^(127\.|localhost$|host\.docker\.internal$|172\.(1[6-9]|2\d|3[01])\.\d+\.1$)/i;

/** Busca el contenedor que hay detrás del destino de NPM (nombre de contenedor o IP:puerto publicado). */
function findTarget(host: NpmProxyHost, npmServerId: string | null, statsList: ServerStats[]) {
  const target = host.forwardHost.toLowerCase();
  const isIp = net.isIP(target) > 0 || target === 'localhost' || target === 'host.docker.internal';
  let server: ServerStats | undefined;
  if (isIp) {
    server = statsList.find((s) => s.ips.includes(target)) ?? (PRIVATE_GATEWAY.test(target) ? statsList.find((s) => s.serverId === npmServerId) : undefined);
  } else {
    server = statsList.find((s) => s.serverId === npmServerId);
  }
  if (!server) return { server: undefined, container: undefined, isIp };
  const byName = (c: ContainerInfo) => {
    const n = c.name.toLowerCase();
    return n === target || n.endsWith(`-${target}-1`) || n.endsWith(`_${target}_1`) || n === `${target}-1` || n.startsWith(`${target}-`);
  };
  const byPort = (c: ContainerInfo) => new RegExp(`[:.]${host.forwardPort}->`).test(c.ports ?? '');
  const container = isIp ? server.containers.find(byPort) : (server.containers.find(byName) ?? server.containers.find(byPort));
  return { server, container, isIp };
}

const STEP_TITLE: Record<RouteStepId, string> = {
  dns: 'Falla el DNS',
  server: 'Falla el servidor',
  tls: 'Falla el certificado',
  proxy: 'Falla Nginx Proxy Manager',
  container: 'Falla el contenedor',
  app: 'Falla la aplicación',
};

export function createDiagnoser(db: DB, npm: NpmService) {
  return async function diagnose(monitor: Monitor): Promise<Diagnosis> {
    const url = new URL(monitor.url);
    const hostname = url.hostname;
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const statsList = readAllStats(db);
    const layoutNodes = readLayout(db).layout.nodes;
    const serverName = (id: string | null | undefined) =>
      (id && (layoutNodes.find((n) => n.serverId === id)?.title || statsList.find((s) => s.serverId === id)?.hostname)) || id || 'el servidor';
    const endpointOf = (id: string) => layoutNodes.find((n) => n.serverId === id && n.portainerEndpointId)?.portainerEndpointId ?? null;

    const match = await npm.findHost(hostname).catch(() => null);
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
    const npmGateway = isNpmServer(p) && (p.status === 502 || p.status === 503 || p.status === 504);
    const forward = match ? `${match.host.forwardScheme}://${match.host.forwardHost}:${match.host.forwardPort}` : null;
    add(
      'proxy',
      proxyLabel,
      'ok',
      match ? `Tiene ${hostname} activo y lo manda a ${forward}.` : isNpmServer(p) ? 'Responde (no está en ningún NPM conectado al panel, así que no sé a dónde lo manda).' : `Responde (${p.server || 'servidor web'}).`,
    );

    /* 5. Contenedor de destino */
    let containerRunning: ContainerInfo | undefined;
    if (match) {
      const { server, container } = findTarget(match.host, match.instance.serverId, statsList);
      const label = container?.name ?? `${match.host.forwardHost}:${match.host.forwardPort}`;
      if (container && container.state !== 'running') {
        const code = exitCode(container);
        const where = serverName(server?.serverId);
        const state =
          container.state === 'exited' ? `parado${code ? ` con error (código ${code})` : ''}` : container.state === 'restarting' ? 'reiniciándose sin parar' : container.state === 'paused' ? 'en pausa' : container.state;
        add('container', label, 'fail', `${container.name} está ${state} en ${where}${container.status ? ` · ${container.status}` : ''}.`);
        const endpointId = server ? endpointOf(server.serverId) : null;
        if (endpointId) action = { kind: 'start-container', endpointId, container: container.name, serverName: where };
        skipRest(['app']);
        return finish();
      }
      if (container) {
        containerRunning = container;
        add('container', label, 'ok', `En marcha en ${serverName(server?.serverId)}${container.status ? ` · ${container.status}` : ''}.`);
      } else if (server && !server.online) {
        add('container', label, 'fail', `${serverName(server.serverId)}, donde está ${match.host.forwardHost}, no envía datos desde hace ${minutesAgo(server.lastUpdated)}: está apagado o sin red.`);
        skipRest(['app']);
        return finish();
      } else {
        add(
          'container',
          label,
          npmGateway ? 'warn' : 'skip',
          server
            ? `No encuentro el contenedor de ${match.host.forwardHost}:${match.host.forwardPort} en ${serverName(server.serverId)}. Si el destino es una IP, actualiza el script de métricas para que envíe los puertos.`
            : `${match.host.forwardHost} no es de ningún servidor del panel${match.instance.serverId ? '' : ' (indica en qué servidor está este NPM)'}.`,
        );
      }
    } else {
      add(
        'container',
        'Contenedor',
        'skip',
        npm.domainsByInstance().length
          ? `${hostname} no está en ningún Nginx Proxy Manager conocido, así que no sé qué contenedor hay detrás.`
          : 'Aún no sé qué contenedor hay detrás: actualiza el script de métricas en el servidor donde está Nginx Proxy Manager y el panel lo leerá solo.',
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
      add('app', 'Aplicación', p.status === 401 || p.status === 403 ? 'warn' : 'fail', `Responde ${p.status}${p.status === 404 ? ': la página no existe en la aplicación' : p.status === 401 || p.status === 403 ? ': pide acceso (puede ser normal)' : ''}.`);
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
