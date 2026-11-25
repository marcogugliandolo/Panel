import type {
  ContainerAction,
  HistoryRange,
  Layout,
  MetricPoint,
  Monitor,
  MonitorHistory,
  MonitorInput,
  PortainerContainer,
  PortainerEndpoint,
  PortainerStatus,
  ServerStats,
  WebBars,
  WebIncident,
  WebTraffic,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Se emite cuando la sesión caduca: la app vuelve a la pantalla de acceso. */
export const UNAUTHORIZED_EVENT = 'panel:unauthorized';

async function request<T>(path: string, options: { method?: string; body?: unknown; text?: boolean } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-Panel-Request'] = '1';

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError('No hay conexión con el panel', 0);
  }

  if (response.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* respuesta sin JSON */
    }
    throw new ApiError(message, response.status);
  }
  return (options.text ? await response.text() : await response.json()) as T;
}

export interface Session {
  authenticated: boolean;
  username?: string;
  /** Contraseña correcta pero falta el código del doble factor. */
  twoFactor?: boolean;
  ticket?: string;
  /** Solo si se ha entrado con un código de recuperación. */
  recoveryLeft?: number;
}

export interface NotifyRules {
  servers: boolean;
  containers: boolean;
  webs: boolean;
  certs: boolean;
  resources: boolean;
  manualStops: boolean;
}
export interface NotifyStatus {
  active: boolean;
  source: 'panel' | 'env';
  bot: { username: string; name: string } | null;
  hasToken: boolean;
  chat: { id: string; title: string } | null;
  rules: NotifyRules;
  lastSentAt: number | null;
  lastError: string | null;
  problems: string[];
}
export interface TelegramChat {
  id: string;
  title: string;
  type: string;
}

export interface NpmInstance {
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
/** NPM leído por el script de métricas en un servidor (sin usuario ni contraseña). */
export interface NpmDetected extends NpmInstance {
  title: string;
  online: boolean;
}
export interface NpmInstanceInput {
  name: string;
  url: string;
  email: string;
  password: string;
  serverId: string | null;
  autoImport: boolean;
}
export interface NpmHost {
  id: number;
  domains: string[];
  forwardScheme: string;
  forwardHost: string;
  forwardPort: number;
  enabled: boolean;
  ssl: boolean;
  online: boolean;
  error: string | null;
  watched: string[];
  importable: string[];
}

export interface DiscoveryCandidate {
  host: string;
  source: 'certificados' | 'npm';
  resolves: boolean;
  responds: boolean;
  status: number | null;
  certAt: number | null;
  checkedAt: number;
}
export interface DiscoveryState {
  /** Con «solo las webs de NPM» no se buscan webs en los certificados. */
  npmOnly?: boolean;
  running: boolean;
  lastRun: number | null;
  lastError: string | null;
  sources: string[];
  domains: string[];
  extraDomains: string[];
  candidates: DiscoveryCandidate[];
}

/** Una web apartada: no funciona (o está mal en NPM) y se vuelve a probar cada 10 minutos. */
export interface DormantWeb {
  host: string;
  name: string;
  url: string;
  /** never: no ha respondido nunca · down: lleva un día sin responder · npm: desactivada o con error en NPM */
  reason: 'never' | 'down' | 'npm';
  since: number;
  lastOk: number | null;
  lastProbe: number | null;
  lastError: string | null;
}

/** Qué webs se vigilan: «solo las de Nginx Proxy Manager» y «solo las que funcionan». */
export interface WebScope {
  npmOnly: boolean;
  onlyWorking: boolean;
  /** false mientras no se sepa nada de ningún NPM (no se quita nada por NPM). */
  ready: boolean;
  /** Webs vigiladas que no están en ningún NPM. */
  outside: { id: number; name: string; url: string }[];
  lastPruned: { at: number; names: string[] } | null;
  lastRestored: { at: number; names: string[] } | null;
  dormant: DormantWeb[];
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: number | null;
  recoveryLeft: number;
}
export interface TwoFactorSetup {
  secret: string;
  uri: string;
  qr: string;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<Session>('/auth/me'),
  login: (username: string, password: string) =>
    request<Session>('/auth/login', { method: 'POST', body: { username, password } }),
  loginCode: (ticket: string, code: string) => request<Session>('/auth/login/code', { method: 'POST', body: { ticket, code } }),
  logout: () => request<Session>('/auth/logout', { method: 'POST' }),

  notify: () => request<NotifyStatus>('/notify'),
  notifyBot: (token: string) => request<NotifyStatus>('/notify/bot', { method: 'POST', body: { token } }),
  notifyChats: () => request<TelegramChat[]>('/notify/chats'),
  notifyChat: (chat: TelegramChat) =>
    request<NotifyStatus>('/notify/chat', { method: 'POST', body: { chatId: chat.id, title: chat.title, panelUrl: window.location.origin } }),
  notifyRules: (rules: Partial<NotifyRules>) => request<NotifyStatus>('/notify/rules', { method: 'PUT', body: rules }),
  notifyTest: () => request<NotifyStatus>('/notify/test', { method: 'POST' }),
  notifyDisconnect: () => request<NotifyStatus>('/notify', { method: 'DELETE' }),

  twoFactor: () => request<TwoFactorStatus>('/auth/2fa'),
  twoFactorSetup: () => request<TwoFactorSetup>('/auth/2fa/setup', { method: 'POST' }),
  twoFactorEnable: (code: string) =>
    request<{ recoveryCodes: string[]; closedSessions: number }>('/auth/2fa/enable', { method: 'POST', body: { code } }),
  twoFactorDisable: (password: string, code: string) =>
    request<TwoFactorStatus>('/auth/2fa/disable', { method: 'POST', body: { password, code } }),
  twoFactorRecovery: (code: string) => request<{ recoveryCodes: string[] }>('/auth/2fa/recovery', { method: 'POST', body: { code } }),

  stats: () => request<ServerStats[]>('/stats'),
  history: (serverId: string, range: HistoryRange) =>
    request<{ range: HistoryRange; bucketMs: number; points: MetricPoint[] }>(
      `/stats/${enc(serverId)}/history?range=${range}`,
    ),
  forgetServer: (serverId: string) => request<{ success: boolean }>(`/stats/${enc(serverId)}`, { method: 'DELETE' }),

  layout: () => request<{ layout: Layout; saved: boolean }>('/layout'),
  saveLayout: (layout: Layout) => request<{ layout: Layout; saved: boolean }>('/layout', { method: 'PUT', body: layout }),

  portainerStatus: () => request<PortainerStatus>('/portainer/status'),
  endpoints: () => request<PortainerEndpoint[]>('/portainer/endpoints'),
  containers: (endpointId: number) => request<PortainerContainer[]>(`/portainer/endpoints/${endpointId}/containers`),
  containerAction: (endpointId: number, containerId: string, action: ContainerAction) =>
    request<{ success: boolean }>(`/portainer/endpoints/${endpointId}/containers/${enc(containerId)}/${action}`, {
      method: 'POST',
    }),
  containerLogs: (endpointId: number, containerId: string, tail = 300) =>
    request<string>(`/portainer/endpoints/${endpointId}/containers/${enc(containerId)}/logs?tail=${tail}`, {
      text: true,
    }),

  monitors: () => request<Monitor[]>('/monitors'),
  createMonitor: (input: MonitorInput) => request<Monitor>('/monitors', { method: 'POST', body: input }),
  updateMonitor: (id: number, input: Partial<MonitorInput>) =>
    request<Monitor>(`/monitors/${id}`, { method: 'PUT', body: input }),
  deleteMonitor: (id: number) => request<{ success: boolean }>(`/monitors/${id}`, { method: 'DELETE' }),
  checkMonitor: (id: number) => request<Monitor>(`/monitors/${id}/check`, { method: 'POST' }),
  diagnoseMonitor: (id: number) => request<Monitor>(`/monitors/${id}/diagnose`, { method: 'POST' }),

  npmInstances: () => request<NpmInstance[]>('/npm'),
  npmAdd: (input: NpmInstanceInput) => request<NpmInstance>('/npm', { method: 'POST', body: input }),
  npmUpdate: (id: number, input: Partial<NpmInstanceInput>) => request<NpmInstance>(`/npm/${id}`, { method: 'PUT', body: input }),
  npmRemove: (id: number) => request<{ success: boolean }>(`/npm/${id}`, { method: 'DELETE' }),
  npmHosts: (id: number, refresh = false) => request<NpmHost[]>(`/npm/${id}/hosts${refresh ? '?refresh=1' : ''}`),
  npmImport: (id: number, domains: string[]) => request<{ added: string[] }>(`/npm/${id}/import`, { method: 'POST', body: { domains } }),
  npmDetected: () => request<NpmDetected[]>('/npm/detected'),
  npmDetectedHosts: (serverId: string) => request<NpmHost[]>(`/npm/detected/${enc(serverId)}/hosts`),
  npmDetectedImport: (serverId: string, domains: string[]) =>
    request<{ added: string[] }>(`/npm/detected/${enc(serverId)}/import`, { method: 'POST', body: { domains } }),
  npmDetectedAuto: (serverId: string, autoImport: boolean) =>
    request<NpmDetected>(`/npm/detected/${enc(serverId)}`, { method: 'PUT', body: { autoImport } }),
  webBars: () => request<WebBars>('/monitors/bars'),
  webScope: () => request<WebScope>('/webs/scope'),
  webScopeSet: (body: { npmOnly?: boolean; onlyWorking?: boolean }) => request<WebScope>('/webs/scope', { method: 'PUT', body }),
  webScopePrune: () => request<WebScope & { removed: string[]; setAside: string[] }>('/webs/scope/prune', { method: 'POST' }),
  webScopeRecheck: () => request<WebScope & { back: string[] }>('/webs/scope/recheck', { method: 'POST' }),
  webScopeKeep: (host: string) => request<WebScope>('/webs/scope/keep', { method: 'POST', body: { host } }),
  webScopeForget: (target: { host: string } | { all: true }) => request<WebScope>('/webs/scope/forget', { method: 'POST', body: target }),
  discovery: () => request<DiscoveryState>('/discovery'),
  discoveryRun: () => request<DiscoveryState>('/discovery/run', { method: 'POST' }),
  discoveryWatch: (hosts: string[]) => request<DiscoveryState & { added: string[] }>('/discovery/watch', { method: 'POST', body: { hosts } }),
  discoveryDismiss: (hosts: string[]) => request<DiscoveryState>('/discovery/dismiss', { method: 'POST', body: { hosts } }),
  discoveryDomains: (domains: string[]) => request<DiscoveryState>('/discovery/domains', { method: 'PUT', body: { domains } }),
  webIncidents: (id: number, range: HistoryRange) => request<WebIncident[]>(`/monitors/${id}/incidents?range=${range}`),
  webTraffic: (id: number, range: HistoryRange) => request<WebTraffic>(`/monitors/${id}/traffic?range=${range}`),
  monitorHistory: (id: number, range: HistoryRange) =>
    request<MonitorHistory & { bucketMs: number }>(`/monitors/${id}/history?range=${range}`),
};
