// Tipos compartidos entre el servidor (server/) y la interfaz (src/).

export const THRESHOLDS = {
  cpu: 80,
  ram: 85,
  disk: 90,
  /** Días antes de que caduque un certificado SSL para avisar. */
  certDays: 14,
} as const;

// --- Métricas de servidores ---

export interface ContainerInfo {
  name: string;
  /** running, exited, restarting, paused, created, dead… o "unknown" si el script solo envía nombres. */
  state: string;
  status?: string | null;
  image?: string | null;
}

export interface ServerStats {
  serverId: string;
  hostname: string | null;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  uptimeSeconds: number | null;
  appsTotal: number | null;
  appsRunning: number | null;
  containers: ContainerInfo[];
  /** Milisegundos desde epoch del último envío del script. */
  lastUpdated: number;
  /** false si lleva más de OFFLINE_AFTER_MINUTES sin enviar datos. */
  online: boolean;
}

export interface MetricPoint {
  t: number;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  cpuMax: number | null;
}

export type HistoryRange = '1h' | '6h' | '24h' | '7d' | '30d';

// --- Esquema (layout) ---

export type NodeIcon = 'Globe' | 'Cloud' | 'Router' | 'ServerIcon' | 'Cpu' | 'Database' | 'HardDrive' | 'Shield';
export type ZoneColor = 'purple' | 'blue' | 'green' | 'amber';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  icon: NodeIcon;
  ip?: string;
  /** Id con el que el script de métricas envía los datos (POST /api/stats/:id). */
  serverId?: string;
  /** Entorno de Portainer asociado, para el control de contenedores. */
  portainerEndpointId?: number;
  isGateway?: boolean;
}

export interface LayoutZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  icon: NodeIcon;
  color: ZoneColor;
}

export interface LayoutWire {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface Layout {
  nodes: LayoutNode[];
  zones: LayoutZone[];
  wires: LayoutWire[];
}

// --- Portainer ---

export interface PortainerStatus {
  configured: boolean;
  ok: boolean;
  error?: string;
  version?: string;
}

export interface PortainerEndpoint {
  id: number;
  name: string;
  online: boolean;
}

export interface PortainerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  stack: string | null;
  ports: string[];
  /** El contenedor de este mismo panel. */
  isSelf: boolean;
  /** Portainer o su agente: pararlo corta el acceso a la gestión. */
  isPortainer: boolean;
}

export type ContainerAction = 'start' | 'stop' | 'restart';

// --- Monitor de webs ---

export type MonitorStatus = 'up' | 'warning' | 'down' | 'pending' | 'paused';

export interface MonitorCheck {
  ts: number;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface Monitor {
  id: number;
  name: string;
  url: string;
  intervalSec: number;
  timeoutMs: number;
  keyword: string | null;
  enabled: boolean;
  status: MonitorStatus;
  lastCheck: MonitorCheck | null;
  uptime24h: number | null;
  uptime7d: number | null;
  avgLatency24h: number | null;
  recent: { ts: number; ok: boolean; latencyMs: number | null }[];
  cert: {
    expiresAt: number | null;
    issuer: string | null;
    error: string | null;
    checkedAt: number | null;
  } | null;
}

export interface MonitorInput {
  name: string;
  url: string;
  intervalSec?: number;
  timeoutMs?: number;
  keyword?: string | null;
  enabled?: boolean;
}

export interface MonitorHistoryPoint {
  t: number;
  uptime: number | null;
  latency: number | null;
  checks: number;
}

export interface MonitorHistory {
  points: MonitorHistoryPoint[];
  failures: MonitorCheck[];
}
