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
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<Session>('/auth/me'),
  login: (username: string, password: string) =>
    request<Session>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<Session>('/auth/logout', { method: 'POST' }),

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
  monitorHistory: (id: number, range: HistoryRange) =>
    request<MonitorHistory & { bucketMs: number }>(`/monitors/${id}/history?range=${range}`),
};
