import express from 'express';
import os from 'node:os';
import type { ContainerAction, PortainerContainer, PortainerEndpoint, PortainerStatus } from '../../shared/types';
import { config } from '../config';

const ACTIONS: ContainerAction[] = ['start', 'stop', 'restart'];
const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const REQUEST_TIMEOUT_MS = 15_000;

class PortainerError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

const isConfigured = () => Boolean(config.portainerUrl && config.portainerToken);

async function portainerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isConfigured()) throw new PortainerError('Portainer no está configurado', 503);
  let response: Response;
  try {
    response = await fetch(`${config.portainerUrl}/api${path}`, {
      ...init,
      headers: { 'X-API-Key': config.portainerToken, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'no responde' : 'no se puede alcanzar';
    throw new PortainerError(`Portainer ${reason} (${config.portainerUrl})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new PortainerError('Portainer ha rechazado el token (PORTAINER_TOKEN)', 502);
  }
  if (response.status === 404) throw new PortainerError('No encontrado en Portainer', 404);
  if (!response.ok && response.status !== 304) {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string; details?: string };
      detail = body.message || body.details || '';
    } catch {
      /* sin cuerpo */
    }
    throw new PortainerError(`Portainer respondió ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response;
}

/** Docker multiplexa stdout/stderr con cabeceras de 8 bytes cuando el contenedor no usa TTY. */
function demuxDockerLogs(buffer: Buffer): string {
  const looksMultiplexed =
    buffer.length >= 8 && buffer[0] <= 2 && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0;
  if (!looksMultiplexed) return buffer.toString('utf8');
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Dentro de Docker, el hostname es el id corto del contenedor: así se reconoce el propio panel.
const selfId = os.hostname();

function mapContainer(raw: any): PortainerContainer {
  const id = String(raw.Id ?? '');
  const image = String(raw.Image ?? '');
  const ports = new Set<string>();
  for (const port of raw.Ports ?? []) {
    if (port.PublicPort) ports.add(`${port.PublicPort}→${port.PrivatePort}/${port.Type}`);
  }
  return {
    id,
    name: String(raw.Names?.[0] ?? id.slice(0, 12)).replace(/^\//, ''),
    image,
    state: String(raw.State ?? 'unknown').toLowerCase(),
    status: String(raw.Status ?? ''),
    created: Number(raw.Created ?? 0) * 1000,
    stack: raw.Labels?.['com.docker.compose.project'] ?? null,
    ports: [...ports],
    isSelf: selfId.length >= 12 && id.startsWith(selfId),
    isPortainer: /portainer\/(portainer|agent)/i.test(image),
  };
}

function endpointParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new PortainerError('Entorno no válido', 400);
  return id;
}

function containerParam(value: string): string {
  if (!CONTAINER_ID.test(value)) throw new PortainerError('Contenedor no válido', 400);
  return value;
}

type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;
const wrap =
  (handler: AsyncHandler): express.RequestHandler =>
  (req, res) => {
    handler(req, res).catch((error) => {
      const status = error instanceof PortainerError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Error inesperado';
      if (status >= 500) console.error('[portainer]', message);
      res.status(status).json({ error: message });
    });
  };

export function createPortainerRouter() {
  const router = express.Router();

  router.get(
    '/status',
    wrap(async (_req, res) => {
      if (!isConfigured()) {
        res.json({ configured: false, ok: false } satisfies PortainerStatus);
        return;
      }
      try {
        const response = await portainerFetch('/system/status');
        const body = (await response.json()) as { Version?: string };
        res.json({ configured: true, ok: true, version: body.Version } satisfies PortainerStatus);
      } catch (error) {
        res.json({ configured: true, ok: false, error: (error as Error).message } satisfies PortainerStatus);
      }
    }),
  );

  router.get(
    '/endpoints',
    wrap(async (_req, res) => {
      const response = await portainerFetch('/endpoints');
      const raw = (await response.json()) as any[];
      const endpoints: PortainerEndpoint[] = raw.map((e) => ({
        id: Number(e.Id),
        name: String(e.Name ?? `Entorno ${e.Id}`),
        online: e.Status === 1,
      }));
      res.json(endpoints);
    }),
  );

  router.get(
    '/endpoints/:endpointId/containers',
    wrap(async (req, res) => {
      const endpointId = endpointParam(req.params.endpointId);
      const response = await portainerFetch(`/endpoints/${endpointId}/docker/containers/json?all=1`);
      const raw = (await response.json()) as any[];
      const containers = raw.map(mapContainer).sort((a, b) => {
        // Primero los que no están en marcha, para que salten a la vista.
        const rank = (c: PortainerContainer) => (c.state === 'running' ? 1 : 0);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
      res.json(containers);
    }),
  );

  router.post(
    '/endpoints/:endpointId/containers/:containerId/:action',
    wrap(async (req, res) => {
      const endpointId = endpointParam(req.params.endpointId);
      const containerId = containerParam(req.params.containerId);
      const action = req.params.action as ContainerAction;
      if (!ACTIONS.includes(action)) throw new PortainerError('Acción no permitida', 400);
      await portainerFetch(`/endpoints/${endpointId}/docker/containers/${containerId}/${action}`, { method: 'POST' });
      console.log(`[portainer] ${res.locals.username} → ${action} ${containerId.slice(0, 12)} (entorno ${endpointId})`);
      res.json({ success: true });
    }),
  );

  router.get(
    '/endpoints/:endpointId/containers/:containerId/logs',
    wrap(async (req, res) => {
      const endpointId = endpointParam(req.params.endpointId);
      const containerId = containerParam(req.params.containerId);
      const tail = Math.min(2000, Math.max(10, Number(req.query.tail) || 200));
      const response = await portainerFetch(
        `/endpoints/${endpointId}/docker/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
      );
      const text = demuxDockerLogs(Buffer.from(await response.arrayBuffer()));
      res.type('text/plain; charset=utf-8').send(text);
    }),
  );

  return router;
}
