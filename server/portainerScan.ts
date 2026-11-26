/**
 * Lo que el panel sabe de cada servidor a través de Portainer, sin depender del script de métricas:
 *   · todos los contenedores con su red (IPs internas, servicio del stack, alias) y sus puertos
 *     (también los de los parados, de su configuración);
 *   · los proxy hosts de Nginx Proxy Manager, leídos de sus archivos (`/data/nginx/proxy_host`) con la
 *     API de Docker (lo mismo que `docker cp`).
 * Así se sabe qué contenedor hay detrás de cada web aunque el script de ese servidor sea antiguo.
 * Cada entorno de Portainer se asocia a su servidor del panel (por el plano, por los contenedores que
 * tienen en común o por el nombre); si no corresponde a ninguno, cuenta como un servidor más.
 */
import type { ContainerInfo, DetectedNpmHost, ServerStats } from '../shared/types';
import type { DB } from './db';
import { parseNginxMinute, type TrafficSample } from './incidents';
import { parseAdvanced } from './npmConf';
import { readLayout } from './routes/layout';
import { isConfigured, portainerFetch } from './routes/portainer';
import { createIpMemory, readAllStats } from './routes/stats';

const NPM_IMAGE = /nginx-proxy-manager|npmplus|nginxproxymanager|jc21\/nginx/i;
const EVERY_MS = Number(process.env.PORTAINER_SCAN_MS) || 60_000;

export interface EndpointScan {
  endpointId: number;
  name: string;
  /** Servidor del panel al que corresponde, o «portainer-<id>» si no es ninguno. */
  serverId: string;
  title: string;
  mapped: boolean;
  containers: ContainerInfo[];
  npm: { container: string; hosts: DetectedNpmHost[] } | null;
  at: number;
}

/** Archivos de un tar (lo que devuelve Docker en /archive): ruta → contenido. */
export function readTar(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 136).trim() || '0', 8) || 0;
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    const prefix = field(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    off += 512;
    const body = buf.subarray(off, off + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
    else if (type === 'x') {
      const path = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      if (path) longName = path[1];
    } else if (type === '0' || type === '7') {
      files.set(name, body.toString('utf8'));
      name = '';
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Un archivo de proxy host de NPM (como lo lee el script de métricas). */
export function parseNpmConf(text: string, isErr: boolean): DetectedNpmHost | null {
  let names = '';
  let host = '';
  let port = '';
  let scheme = 'http';
  let ssl = false;
  for (const line of text.split('\n')) {
    let m: RegExpMatchArray | null;
    if (!names && (m = line.match(/^\s*server_name\s+([^;]+)/))) names = m[1].replace(/["\\]/g, '');
    else if (!host && (m = line.match(/^\s*set\s+\$server\s+([^;]+)/))) host = m[1].replace(/["\\\s]/g, '');
    else if (!port && (m = line.match(/^\s*set\s+\$port\s+([^;\s]+)/))) port = m[1].replace(/"/g, '');
    else if ((m = line.match(/^\s*set\s+\$forward_scheme\s+([^;\s]+)/))) scheme = m[1].replace(/["\\]/g, '');
    if (/^\s*listen\s.*443/.test(line)) ssl = true;
  }
  const domains = names.trim().split(/\s+/).filter(Boolean).map((d) => d.toLowerCase());
  if (!domains.length) return null;
  const { root, fallback } = parseAdvanced(text);
  return { domains, host, port: /^\d+$/.test(port) ? Number(port) : 0, scheme, ssl, error: isErr, root, fallback };
}

const HEX12 = /^[0-9a-f]{12,}$/;

/** Salida de un `docker exec` sin TTY: trozos con una cabecera de 8 bytes (tipo y tamaño). Solo stdout. */
export function demux(buf: Buffer): string {
  const parts: Buffer[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off];
    const size = buf.readUInt32BE(off + 4);
    if (type === 1) parts.push(buf.subarray(off + 8, off + 8 + size));
    off += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Comprobaciones automáticas (este panel, Uptime Kuma…): no son visitas reales. */
const MONITOR_UA = /ServerPanel-Monitor|Uptime-Kuma|UptimeRobot|Better ?Uptime|StatusCake|Pingdom|HetrixTools|Site24x7/i;

/**
 * Cuenta las visitas por web y minuto de unas líneas del registro de NPM
 * («[26/Nov/2026:08:22:15 +0000] - 200 200 - GET https web.com "/" [Client …] … "agente" "-"»).
 */
export function countVisits(text: string): TrafficSample[] {
  const by = new Map<string, TrafficSample>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([^\]]+)\] \S+ (\S+) (\d{3}|-) - \S+ \S+ (\S+) "/);
    if (!m || MONITOR_UA.test(line)) continue;
    // «26/Nov/2026:08:22:15 +0000» → por minuto («26/Nov/2026:08:22 +0000»), como hace el script.
    const minute = parseNginxMinute(m[1].replace(/^(\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}):\d{2}/, '$1'));
    const host = m[4].toLowerCase();
    if (minute === null || !/^[a-z0-9.-]{1,253}$/.test(host)) continue;
    const status = Number(m[3] === '-' ? m[2] : m[3]);
    const key = `${host}|${minute}`;
    const s = by.get(key) ?? { host, minute, requests: 0, failed: 0, gateway: 0 };
    s.requests++;
    if (status >= 500) s.failed++;
    if (status === 502 || status === 503 || status === 504) s.gateway++;
    by.set(key, s);
  }
  return [...by.values()];
}

/** Un contenedor tal como lo da la API de Docker (lista o inspect). */
function toContainer(raw: any, bindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null>, extraAliases: string[] = []): ContainerInfo {
  const name = String(raw.Names?.[0] ?? raw.Name ?? '').replace(/^\//, '');
  const ports = new Set<string>();
  for (const p of raw.Ports ?? []) {
    if (p.PublicPort) ports.add(`0.0.0.0:${p.PublicPort}->${p.PrivatePort}/${p.Type}`);
    else if (p.PrivatePort) ports.add(`${p.PrivatePort}/${p.Type}`);
  }
  for (const [inside, list] of Object.entries(bindings ?? {})) {
    for (const b of list ?? []) if (b.HostPort) ports.add(`0.0.0.0:${b.HostPort}->${inside}`);
  }
  const labels = raw.Labels ?? raw.Config?.Labels ?? {};
  const networks = (raw.NetworkSettings?.Networks ?? {}) as Record<string, { IPAddress?: string; Aliases?: string[] | null; DNSNames?: string[] | null }>;
  const aliases = new Set<string>();
  if (labels['com.docker.compose.service']) aliases.add(String(labels['com.docker.compose.service']));
  for (const a of extraAliases) if (a && a !== name && !HEX12.test(a)) aliases.add(a);
  const ips = new Set<string>();
  for (const n of Object.values(networks)) {
    if (n.IPAddress && /^\d+\.\d+\.\d+\.\d+$/.test(n.IPAddress)) ips.add(n.IPAddress);
    for (const a of [...(n.Aliases ?? []), ...(n.DNSNames ?? [])]) if (a && a !== name && !HEX12.test(a)) aliases.add(a);
  }
  const state = String(raw.State?.Status ?? raw.State ?? 'unknown').toLowerCase();
  return {
    name,
    state,
    status: raw.Status ?? null,
    image: raw.Image ?? raw.Config?.Image ?? null,
    ports: [...ports].join(', ') || null,
    ...(aliases.size ? { aliases: [...aliases] } : {}),
    ...(ips.size ? { ips: [...ips] } : {}),
  };
}

export function createPortainerScan(db: DB, onVisits: (samples: TrafficSample[]) => void = () => undefined) {
  let scans: EndpointScan[] = [];
  /**
   * Detalle de cada contenedor (alias de red y puertos configurados), que la lista no trae. Se pide
   * una sola vez por contenedor: el id cambia si se recrea.
   */
  const detail = new Map<string, { aliases: string[]; bindings: Record<string, { HostIp?: string; HostPort?: string }[]> | undefined }>();
  let running = false;
  let lastError: string | null = null;
  const rememberIps = createIpMemory(db);

  async function json<T>(path: string): Promise<T> {
    return (await (await portainerFetch(path)).json()) as T;
  }

  /** Ejecuta un comando de solo lectura dentro de un contenedor (como `docker exec`) y devuelve su salida. */
  async function execIn(endpointId: number, containerId: string, script: string): Promise<string> {
    const base = `/endpoints/${endpointId}/docker`;
    const headers = { 'Content-Type': 'application/json' };
    const created = (await (
      await portainerFetch(`${base}/containers/${containerId}/exec`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ AttachStdout: true, AttachStderr: false, Tty: false, Cmd: ['sh', '-c', script] }),
      })
    ).json()) as { Id: string };
    const res = await portainerFetch(`${base}/exec/${created.Id}/start`, { method: 'POST', headers, body: JSON.stringify({ Detach: false, Tty: false }) });
    return demux(Buffer.from(await res.arrayBuffer()));
  }

  /**
   * Visitas reales desde los registros de NPM (`/data/logs/proxy-host-N_access.log`): cada vuelta se
   * lee solo lo nuevo de cada archivo (la primera vez, el último trozo); si NPM rota el registro, se
   * empieza el nuevo. Hace lo mismo que el script de métricas cuando ese script es antiguo.
   */
  const logPos = new Map<string, { inode: string; pos: number }>();
  const FIRST_READ = 128 * 1024;
  const MAX_READ = 2 * 1024 * 1024;
  async function readVisits(endpointId: number, containerId: string): Promise<TrafficSample[]> {
    const listing = await execIn(endpointId, containerId, "cd /data/logs 2>/dev/null && stat -c '%n %i %s' proxy-host-*_access.log 2>/dev/null");
    const plan: { file: string; inode: string; from: number; to: number }[] = [];
    for (const line of listing.split('\n')) {
      const [file, inode, sizeText] = line.trim().split(/\s+/);
      const size = Number(sizeText);
      if (!/^proxy-host-\d+_access\.log$/.test(file ?? '') || !Number.isFinite(size)) continue;
      const key = `${endpointId}:${file}`;
      const prev = logPos.get(key);
      let from = prev && prev.inode === inode && size >= prev.pos ? prev.pos : prev ? 0 : Math.max(0, size - FIRST_READ);
      if (size - from > MAX_READ) from = size - MAX_READ;
      if (size > from) plan.push({ file, inode, from, to: size });
      else logPos.set(key, { inode, pos: size });
    }
    if (!plan.length) return [];
    // Un trozo por archivo, exactamente hasta el tamaño visto (lo que se escriba después, la próxima vez).
    const script = `cd /data/logs && ${plan.map((p) => `echo '### ${p.file}'; tail -c +${p.from + 1} ${p.file} | head -c ${p.to - p.from}; echo`).join('; ')}`;
    const out = await execIn(endpointId, containerId, script);
    for (const p of plan) logPos.set(`${endpointId}:${p.file}`, { inode: p.inode, pos: p.to });
    // La primera lectura puede empezar a mitad de línea: esa línea no cuadra con el formato y se ignora sola.
    return countVisits(out);
  }

  /** A qué servidor del panel corresponde un entorno de Portainer. */
  function mapEndpoint(ep: { Id: number; Name: string }, containers: ContainerInfo[], stats: ServerStats[]) {
    const nodes = readLayout(db).layout.nodes;
    const titleOf = (id: string) => nodes.find((n) => n.serverId === id)?.title || stats.find((s) => s.serverId === id)?.hostname || id;
    const node = nodes.find((n) => n.portainerEndpointId === ep.Id && n.serverId);
    if (node?.serverId) return { serverId: node.serverId, title: titleOf(node.serverId), mapped: true };
    // Por los contenedores que tienen en común con lo que envía el script.
    const names = new Set(containers.map((c) => c.name));
    let best: { s: ServerStats; common: number } | null = null;
    for (const s of stats) {
      const common = s.containers.filter((c) => names.has(c.name)).length;
      if (!best || common > best.common) best = { s, common };
    }
    if (best && best.common >= 2 && best.common >= 0.5 * Math.min(names.size, best.s.containers.length || 1)) {
      return { serverId: best.s.serverId, title: titleOf(best.s.serverId), mapped: true };
    }
    // Por el nombre.
    const n = ep.Name.toLowerCase();
    const byName = stats.find((s) =>
      [s.serverId, s.hostname, titleOf(s.serverId)].some((x) => x && x.length >= 4 && (x.toLowerCase() === n || n.includes(x.toLowerCase()) || x.toLowerCase().includes(n))),
    );
    if (byName && n.length >= 4) return { serverId: byName.serverId, title: titleOf(byName.serverId), mapped: true };
    return { serverId: `portainer-${ep.Id}`, title: ep.Name, mapped: false };
  }

  async function scanEndpoint(ep: { Id: number; Name: string }, stats: ServerStats[]): Promise<EndpointScan> {
    const base = `/endpoints/${ep.Id}/docker`;
    const list = await json<any[]>(`${base}/containers/json?all=1`);
    const containers: ContainerInfo[] = [];
    let inspected = 0;
    for (const raw of list) {
      const id = `${ep.Id}:${raw.Id}`;
      const stopped = String(raw.State).toLowerCase() !== 'running';
      // Los alias y los puertos configurados no cambian mientras el contenedor no se recree (nuevo id).
      if (!detail.has(id) && inspected < 60) {
        inspected++;
        try {
          const full = await json<any>(`${base}/containers/${raw.Id}/json`);
          const nets = (full.NetworkSettings?.Networks ?? {}) as Record<string, { Aliases?: string[] | null; DNSNames?: string[] | null }>;
          detail.set(id, {
            aliases: Object.values(nets).flatMap((n) => [...(n.Aliases ?? []), ...(n.DNSNames ?? [])]),
            // Un contenedor parado no enseña sus puertos en la lista: se sacan de su configuración.
            bindings: full.HostConfig?.PortBindings ?? undefined,
          });
        } catch {
          /* sin detalle */
        }
      }
      const d = detail.get(id);
      containers.push(toContainer(raw, stopped ? d?.bindings : undefined, d?.aliases));
    }
    // Se olvida el detalle de los contenedores que ya no existen en este entorno.
    const ids = new Set(list.map((raw) => `${ep.Id}:${raw.Id}`));
    for (const id of [...detail.keys()]) if (id.startsWith(`${ep.Id}:`) && !ids.has(id)) detail.delete(id);
    const where = mapEndpoint(ep, containers, stats);
    // Si el script de ese servidor ya lee NPM (y sus registros), las visitas no se cuentan dos veces.
    const scriptReadsNpm = Boolean(stats.find((st) => st.serverId === where.serverId)?.npmHosts);
    // Nginx Proxy Manager: el contenedor con /data montado y su carpeta de proxy hosts.
    let npm: EndpointScan['npm'] = null;
    const candidates = list
      .filter((raw) => (raw.Mounts ?? []).some((m: any) => m.Destination === '/data'))
      .sort((a, b) => Number(NPM_IMAGE.test(String(b.Image))) - Number(NPM_IMAGE.test(String(a.Image))));
    for (const raw of candidates) {
      try {
        const res = await portainerFetch(`${base}/containers/${raw.Id}/archive?path=${encodeURIComponent('/data/nginx/proxy_host')}`);
        const files = readTar(Buffer.from(await res.arrayBuffer()));
        const hosts: DetectedNpmHost[] = [];
        for (const [path, text] of files) {
          const isErr = /\.conf\.err$/.test(path);
          if (!/\.conf$/.test(path) && !isErr) continue;
          const h = parseNpmConf(text, isErr);
          if (h) hosts.push(h);
        }
        npm = { container: String(raw.Names?.[0] ?? '').replace(/^\//, ''), hosts };
        if (!scriptReadsNpm) {
          try {
            const visits = await readVisits(ep.Id, String(raw.Id));
            if (visits.length) onVisits(visits);
          } catch (error) {
            console.warn(`[portainer] No se pueden leer los registros de NPM en ${ep.Name}: ${(error as Error).message}`);
          }
        }
        break;
      } catch {
        /* no es NPM o no se puede leer */
      }
    }
    rememberIps(where.serverId, containers, Date.now());
    return { endpointId: ep.Id, name: ep.Name, ...where, containers, npm, at: Date.now() };
  }

  async function scan() {
    if (running || !isConfigured()) return;
    running = true;
    try {
      const endpoints = await json<{ Id: number; Name: string; Type: number; Status: number }[]>('/endpoints?excludeSnapshots=true');
      const stats = readAllStats(db);
      const next: EndpointScan[] = [];
      const failed: string[] = [];
      for (const ep of endpoints.filter((e) => [1, 2, 4].includes(e.Type))) {
        try {
          next.push(await scanEndpoint(ep, stats));
        } catch (error) {
          failed.push(`${ep.Name}: ${(error as Error).message}`);
          // Si un entorno no responde, se sigue usando lo último que se supo de él.
          const old = scans.find((s) => s.endpointId === ep.Id);
          if (old) next.push(old);
        }
      }
      const found = next.filter((s) => s.npm).map((s) => `${s.title} (${s.npm!.hosts.length} proxy hosts)`);
      if (JSON.stringify(found) !== JSON.stringify(scans.filter((s) => s.npm).map((s) => `${s.title} (${s.npm!.hosts.length} proxy hosts)`))) {
        console.log(`[portainer] Nginx Proxy Manager encontrado en: ${found.join(', ') || 'ningún entorno'}`);
      }
      scans = next;
      lastError = failed.length ? failed.join('; ') : null;
    } catch (error) {
      lastError = (error as Error).message;
    } finally {
      running = false;
    }
  }

  return {
    scan,
    scans: () => scans,
    lastError: () => lastError,
    /** NPM encontrados en Portainer, como si los enviara el script (para npm.ts). */
    npmServers() {
      return scans
        .filter((s) => s.npm)
        .map((s) => ({ serverId: s.serverId, title: s.title, online: true, at: s.at, hosts: s.npm!.hosts }));
    },
    /** Entorno de Portainer de un servidor (para arrancar contenedores desde la ficha). */
    endpointOf: (serverId: string) => scans.find((s) => s.serverId === serverId)?.endpointId ?? null,
    /**
     * Las métricas de los servidores completadas con lo que da Portainer: contenedores que el script no
     * envía, sus IPs, alias y puertos; y los entornos que no son ningún servidor del panel.
     */
    enrich(list: ServerStats[]): ServerStats[] {
      const out = list.map((s) => ({ ...s, containers: s.containers.map((c) => ({ ...c })) }));
      for (const scan of scans) {
        let s = out.find((x) => x.serverId === scan.serverId);
        if (!s) {
          s = {
            serverId: scan.serverId,
            hostname: scan.title,
            cpu: null,
            ram: null,
            disk: null,
            uptimeSeconds: null,
            appsTotal: null,
            appsRunning: null,
            containers: [],
            ips: [],
            npmHosts: null,
            lastUpdated: scan.at,
            online: true,
          };
          out.push(s);
        }
        for (const pc of scan.containers) {
          const c = s.containers.find((x) => x.name === pc.name);
          if (!c) {
            s.containers.push({ ...pc });
            continue;
          }
          if (!c.aliases?.length && pc.aliases?.length) c.aliases = pc.aliases;
          if (!c.ips?.length && pc.ips?.length) c.ips = pc.ips;
          if (!c.ports && pc.ports) c.ports = pc.ports;
          if ((!c.state || c.state === 'unknown') && pc.state) c.state = pc.state;
        }
      }
      return out;
    },
    start() {
      setTimeout(() => void scan(), 5_000).unref();
      setInterval(() => void scan(), EVERY_MS).unref();
    },
  };
}

export type PortainerScan = ReturnType<typeof createPortainerScan>;
