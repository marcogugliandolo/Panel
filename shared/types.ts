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
  /** Puertos tal como los da Docker («0.0.0.0:3004->3000/tcp, :::3004->3000/tcp»). */
  ports?: string | null;
}

/** Un proxy host de NPM tal como lo lee el script de métricas en el servidor. */
export interface DetectedNpmHost {
  domains: string[];
  host: string;
  port: number;
  scheme: string;
  ssl: boolean;
  /** NPM no ha podido cargar su configuración (archivo .conf.err). */
  error: boolean;
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
  /** IPs del servidor (las que da `hostname -I`), si el script las envía. */
  ips: string[];
  /** Proxy hosts del Nginx Proxy Manager de este servidor, leídos por el script de sus archivos (null si no tiene). */
  npmHosts: DetectedNpmHost[] | null;
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

/** Un paso de la ruta que sigue una visita hasta la web. */
export type RouteStepId = 'dns' | 'server' | 'tls' | 'proxy' | 'container' | 'app';
export interface RouteStep {
  id: RouteStepId;
  /** Nombre corto del paso: «DNS», «Oracle», «Nginx Proxy Manager», «kreapc»… */
  label: string;
  /** ok: funciona · fail: aquí se rompe · warn: funciona con algo raro · skip: no se ha podido comprobar o no se llegó */
  status: 'ok' | 'fail' | 'warn' | 'skip';
  detail: string;
}
/** Dónde se ha caído una web: la ruta paso a paso y el primer punto que falla. */
export interface Diagnosis {
  at: number;
  ok: boolean;
  failedAt: RouteStepId | null;
  title: string;
  summary: string;
  steps: RouteStep[];
  /** Arreglo directo si se puede: arrancar el contenedor parado con Portainer. */
  action: { kind: 'start-container'; endpointId: number; container: string; serverName: string } | null;
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
  /** Último diagnóstico de la ruta (se hace solo cuando la web cae, o a mano). */
  diagnosis: Diagnosis | null;
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

/** Un corte de una web: desde el primer fallo confirmado hasta que vuelve a responder. */
export interface WebIncident {
  id: number;
  startedAt: number;
  /** null mientras siga caída. */
  endedAt: number | null;
  durationMs: number;
  /** Lo que devolvió la comprobación (p. ej. «Respuesta HTTP 502»). */
  error: string | null;
  /** Dónde falló, según el diagnóstico de la ruta hecho durante el corte. */
  cause: { title: string; summary: string; failedAt: RouteStepId | null } | null;
  /** Visitas reales que fallaron durante el corte (logs de NPM), si se tienen. */
  failedVisits: number | null;
}

/** Tráfico real de una web leído de los logs de Nginx Proxy Manager. */
export interface WebTrafficPoint {
  t: number;
  requests: number;
  /** Respuestas 5xx (errores del servidor o de la aplicación). */
  failed: number;
  /** 502/503/504: NPM no pudo hablar con el contenedor. */
  gateway: number;
}
export interface WebTraffic {
  bucketMs: number;
  points: WebTrafficPoint[];
  totals: { requests: number; failed: number; gateway: number };
  /** Último minuto con datos de esta web (null si nunca han llegado). */
  lastAt: number | null;
}

/** Minibarras de las últimas 24 h de todas las webs (una por hora). */
export type WebBars = Record<number, { t: number; uptime: number | null }[]>;
