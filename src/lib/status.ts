import { THRESHOLDS, type ContainerInfo, type LayoutNode, type Monitor, type MonitorStatus, type ServerStats } from '../../shared/types';
import { daysUntil, formatPercent, timeAgo } from './format';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export type ServerHealth = 'online' | 'warning' | 'offline' | 'nodata';

export const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  idle: 'var(--color-idle)',
};

export const HEALTH_META: Record<ServerHealth, { label: string; tone: Tone }> = {
  online: { label: 'En línea', tone: 'ok' },
  warning: { label: 'Con avisos', tone: 'warn' },
  offline: { label: 'Sin respuesta', tone: 'bad' },
  nodata: { label: 'Sin datos', tone: 'idle' },
};

export const MONITOR_META: Record<MonitorStatus, { label: string; tone: Tone }> = {
  up: { label: 'Operativa', tone: 'ok' },
  warning: { label: 'Fallo puntual', tone: 'warn' },
  down: { label: 'Caída', tone: 'bad' },
  pending: { label: 'Comprobando', tone: 'idle' },
  paused: { label: 'En pausa', tone: 'idle' },
};

const STATE_LABELS: Record<string, string> = {
  running: 'En marcha',
  exited: 'Parado',
  stopped: 'Detenido',
  restarting: 'Reiniciando',
  paused: 'En pausa',
  created: 'Creado',
  dead: 'Muerto',
  removing: 'Eliminándose',
  unknown: 'Reportado',
};

function exitCode(container: Pick<ContainerInfo, 'status'>): number | null {
  const match = /exited \((\d+)\)/i.exec(container.status ?? '');
  return match ? Number(match[1]) : null;
}

/** Un contenedor parado limpiamente (código 0) no es un problema: suele ser una tarea puntual. */
export function isContainerProblem(container: Pick<ContainerInfo, 'state' | 'status'>): boolean {
  if (container.state === 'restarting' || container.state === 'dead') return true;
  if (container.state === 'exited') {
    const code = exitCode(container);
    return code !== null && code !== 0;
  }
  return false;
}

export function containerStateMeta(container: Pick<ContainerInfo, 'state' | 'status'>): { label: string; tone: Tone } {
  const label = STATE_LABELS[container.state] ?? container.state;
  if (container.state === 'running') return { label, tone: 'ok' };
  if (isContainerProblem(container)) {
    const code = exitCode(container);
    return { label: code ? `${label} (código ${code})` : label, tone: 'bad' };
  }
  if (container.state === 'paused' || container.state === 'restarting') return { label, tone: 'warn' };
  return { label, tone: 'idle' };
}

export interface ServerView {
  /** Id estable para la interfaz: el del nodo o, si no está en el esquema, el del servidor. */
  key: string;
  node: LayoutNode | null;
  serverId: string | null;
  title: string;
  subtitle: string | null;
  stats: ServerStats | null;
  health: ServerHealth;
  /** `detail` va sin el nombre del servidor; los avisos lo anteponen. */
  problems: { id: string; title: string; detail: string }[];
}

function evaluate(stats: ServerStats | null): Pick<ServerView, 'health' | 'problems'> {
  if (!stats) return { health: 'nodata', problems: [] };
  if (!stats.online) {
    return {
      health: 'offline',
      problems: [{ id: 'offline', title: 'Servidor sin respuesta', detail: `No envía datos desde ${timeAgo(stats.lastUpdated)}.` }],
    };
  }
  const problems: ServerView['problems'] = [];
  const checks: [keyof typeof THRESHOLDS, number | null, string][] = [
    ['cpu', stats.cpu, 'CPU'],
    ['ram', stats.ram, 'RAM'],
    ['disk', stats.disk, 'Disco'],
  ];
  for (const [key, value, label] of checks) {
    if (value !== null && value > THRESHOLDS[key]) {
      problems.push({
        id: key,
        title: `${label} alta`,
        detail: `${label} al ${formatPercent(value)} (aviso a partir del ${formatPercent(THRESHOLDS[key], 0)}).`,
      });
    }
  }
  const hasStates = stats.containers.some((c) => c.state !== 'unknown');
  if (hasStates) {
    const failing = stats.containers.filter(isContainerProblem);
    if (failing.length > 0) {
      problems.push({
        id: 'containers',
        title: failing.length === 1 ? 'Contenedor con problemas' : 'Contenedores con problemas',
        detail: `${failing.map((c) => `${c.name} (${containerStateMeta(c).label.toLowerCase()})`).join(', ')}.`,
      });
    }
  } else if (stats.appsTotal !== null && stats.appsRunning !== null && stats.appsRunning < stats.appsTotal) {
    const stopped = stats.appsTotal - stats.appsRunning;
    problems.push({
      id: 'containers',
      title: 'Contenedores detenidos',
      detail: `${stopped} ${stopped === 1 ? 'contenedor detenido' : 'contenedores detenidos'}.`,
    });
  }
  return { health: problems.length > 0 ? 'warning' : 'online', problems };
}

/** Une los nodos del esquema con las métricas recibidas. Los servidores que envían datos sin nodo también aparecen. */
export function buildServerViews(nodes: LayoutNode[], stats: ServerStats[]): ServerView[] {
  const byId = new Map(stats.map((s) => [s.serverId, s]));
  const used = new Set<string>();
  const views: ServerView[] = [];

  for (const node of nodes) {
    if (!node.serverId) continue;
    used.add(node.serverId);
    const serverStats = byId.get(node.serverId) ?? null;
    views.push({
      key: node.id,
      node,
      serverId: node.serverId,
      title: node.title,
      subtitle: node.subtitle ?? null,
      stats: serverStats,
      ...evaluate(serverStats),
    });
  }
  for (const serverStats of stats) {
    if (used.has(serverStats.serverId)) continue;
    const title = serverStats.hostname || serverStats.serverId;
    views.push({
      key: `stats:${serverStats.serverId}`,
      node: null,
      serverId: serverStats.serverId,
      title,
      subtitle: 'Sin ubicar en el esquema',
      stats: serverStats,
      ...evaluate(serverStats),
    });
  }
  return views;
}

export interface PanelAlert {
  id: string;
  severity: 'error' | 'warning';
  title: string;
  message: string;
  target: { kind: 'server'; key: string } | { kind: 'monitor'; id: number };
}

export function buildAlerts(servers: ServerView[], monitors: Monitor[]): PanelAlert[] {
  const alerts: PanelAlert[] = [];
  for (const server of servers) {
    for (const problem of server.problems) {
      alerts.push({
        id: `server:${server.serverId}:${problem.id}`,
        severity: server.health === 'offline' ? 'error' : 'warning',
        title: problem.title,
        message: `${server.title}: ${problem.detail}`,
        target: { kind: 'server', key: server.key },
      });
    }
  }
  for (const monitor of monitors) {
    if (monitor.status === 'down' || monitor.status === 'warning') {
      alerts.push({
        id: `monitor:${monitor.id}:${monitor.status}`,
        severity: monitor.status === 'down' ? 'error' : 'warning',
        title: monitor.status === 'down' ? 'Web caída' : 'Fallo puntual en una web',
        message: `${monitor.name}: ${monitor.lastCheck?.error ?? 'no responde'}.`,
        target: { kind: 'monitor', id: monitor.id },
      });
    }
    const cert = monitor.cert;
    if (monitor.enabled && cert?.expiresAt) {
      const days = daysUntil(cert.expiresAt);
      if (days < THRESHOLDS.certDays) {
        alerts.push({
          id: `monitor:${monitor.id}:cert`,
          severity: days < 3 ? 'error' : 'warning',
          title: days < 0 ? 'Certificado SSL caducado' : 'Certificado SSL a punto de caducar',
          message: days < 0 ? `${monitor.name}: caducó hace ${-days} d.` : `${monitor.name}: caduca en ${days} d.`,
          target: { kind: 'monitor', id: monitor.id },
        });
      }
    }
  }
  return alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
