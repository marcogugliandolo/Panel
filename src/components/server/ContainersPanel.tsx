import { Boxes, FileText, Link2, Play, RefreshCw, RotateCw, Search, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContainerAction, ContainerInfo, PortainerContainer, PortainerEndpoint, PortainerStatus } from '../../../shared/types';
import { api } from '../../api';
import { stripAnsi } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { containerStateMeta, isContainerProblem } from '../../lib/status';
import { cn } from '../../lib/utils';
import { Button, Dialog, EmptyState, IconButton, inputClass, Segmented, Spinner, StatusBadge, useConfirm, useToast } from '../ui';

type Filter = 'all' | 'problems' | 'stopped';

function filterContainers<T extends Pick<ContainerInfo, 'name' | 'state' | 'status'> & { image?: string | null; stack?: string | null }>(
  list: T[],
  query: string,
  filter: Filter,
): T[] {
  const q = query.trim().toLowerCase();
  return list.filter((c) => {
    if (filter === 'problems' && !isContainerProblem(c)) return false;
    if (filter === 'stopped' && c.state === 'running') return false;
    if (!q) return true;
    return [c.name, c.image ?? '', c.stack ?? ''].some((v) => v.toLowerCase().includes(q));
  });
}

function Toolbar({
  query,
  onQuery,
  filter,
  onFilter,
  onRefresh,
  refreshing,
}: {
  query: string;
  onQuery: (q: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1">
        <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search"
          aria-label="Buscar contenedor"
          placeholder="Buscar por nombre, imagen o stack"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className={cn(inputClass, 'h-8 pl-8 text-[13px]')}
        />
      </div>
      <Segmented
        label="Filtrar contenedores"
        value={filter}
        onChange={onFilter}
        options={[
          { value: 'all', label: 'Todos' },
          { value: 'stopped', label: 'Parados' },
          { value: 'problems', label: 'Con fallos' },
        ]}
      />
      {onRefresh && (
        <IconButton label="Actualizar" onClick={onRefresh} className="size-8">
          <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
        </IconButton>
      )}
    </div>
  );
}

export function ContainersPanel({
  serverTitle,
  reported,
  endpointId,
  portainer,
  endpoints,
  onLinkEndpoint,
}: {
  serverTitle: string;
  reported: ContainerInfo[];
  endpointId: number | undefined;
  portainer: PortainerStatus | null;
  endpoints: PortainerEndpoint[] | null;
  /** Solo si el servidor está en el esquema (se guarda en el nodo). */
  onLinkEndpoint?: (endpointId: number) => Promise<void>;
}) {
  if (endpointId && portainer?.ok) {
    return <PortainerContainers endpointId={endpointId} serverTitle={serverTitle} endpointName={endpoints?.find((e) => e.id === endpointId)?.name} />;
  }
  return (
    <div className="space-y-4">
      <LinkCallout
        endpointId={endpointId}
        portainer={portainer}
        endpoints={endpoints}
        serverTitle={serverTitle}
        onLinkEndpoint={onLinkEndpoint}
      />
      <ReportedContainers containers={reported} />
    </div>
  );
}

function LinkCallout({
  endpointId,
  portainer,
  endpoints,
  serverTitle,
  onLinkEndpoint,
}: {
  endpointId: number | undefined;
  portainer: PortainerStatus | null;
  endpoints: PortainerEndpoint[] | null;
  serverTitle: string;
  onLinkEndpoint?: (endpointId: number) => Promise<void>;
}) {
  // Sugerencia por nombre: "Servidor-Contabo" ↔ "Contabo", "Raspberry Pi-1" ↔ "RPi-01"…
  const suggestion = useMemo(() => {
    if (!endpoints) return undefined;
    const simplify = (s: string) => s.toLowerCase().replace(/raspberry\s*pi/g, 'rpi').replace(/servidor|server|[^a-z0-9]/g, '').replace(/0(\d)/g, '$1');
    const target = simplify(serverTitle);
    return endpoints.find((e) => {
      const name = simplify(e.name);
      return name && target && (name.includes(target) || target.includes(name));
    });
  }, [endpoints, serverTitle]);
  const [selected, setSelected] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const value = selected || (suggestion ? String(suggestion.id) : '');

  if (!portainer?.configured) {
    return (
      <p className="rounded-xl border border-line bg-bg/60 p-3 text-[13px] leading-relaxed text-ink-3">
        Para ver todos los contenedores y poder arrancarlos, pararlos o ver sus logs, configura{' '}
        <code className="font-mono text-ink-2">PORTAINER_URL</code> y <code className="font-mono text-ink-2">PORTAINER_TOKEN</code> en el panel.
      </p>
    );
  }
  if (!portainer.ok) {
    return <p className="rounded-xl border border-bad/25 bg-bad/10 p-3 text-[13px] text-bad">Portainer no responde: {portainer.error}</p>;
  }
  if (endpointId) return null;
  if (!onLinkEndpoint) {
    return (
      <p className="rounded-xl border border-line bg-bg/60 p-3 text-[13px] leading-relaxed text-ink-3">
        Añade este servidor al esquema y vincúlalo con su entorno de Portainer para controlar sus contenedores.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-info/25 bg-info/[0.06] p-3">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Link2 size={14} className="text-info" aria-hidden />
        Vincula este servidor con Portainer
      </p>
      <p className="mt-1 text-xs text-ink-3">Así podrás ver todos sus contenedores, arrancarlos, pararlos y leer sus logs.</p>
      <div className="mt-3 flex gap-2">
        <select aria-label="Entorno de Portainer" className={cn(inputClass, 'h-8 text-[13px]')} value={value} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Elige un entorno…</option>
          {endpoints?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.online ? '' : ' (desconectado)'}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={!value}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onLinkEndpoint(Number(value));
            } finally {
              setSaving(false);
            }
          }}
        >
          Vincular
        </Button>
      </div>
    </div>
  );
}

function ReportedContainers({ containers }: { containers: ContainerInfo[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const onlyNames = containers.every((c) => c.state === 'unknown');
  const visible = filterContainers(containers, query, filter);

  if (containers.length === 0) {
    return (
      <EmptyState icon={<Boxes size={24} aria-hidden />} title="El script no ha enviado contenedores">
        Si este servidor usa Docker, actualiza el script de métricas a la versión nueva.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium text-ink">Según el script de métricas</h3>
        <span className="text-xs text-ink-3">{containers.length} contenedores</span>
      </div>
      {onlyNames && (
        <p className="text-xs text-ink-3">El script antiguo solo envía los contenedores en marcha. La versión nueva incluye también los parados y su estado.</p>
      )}
      {!onlyNames && <Toolbar query={query} onQuery={setQuery} filter={filter} onFilter={setFilter} />}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {visible.map((container) => {
          const meta = containerStateMeta(container);
          return (
            <li key={container.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-[13px] text-ink">{container.name}</p>
                {(container.image || container.status) && (
                  <p className="truncate text-xs text-ink-3">{[container.image, container.status].filter(Boolean).join(' · ')}</p>
                )}
              </div>
              <StatusBadge tone={meta.tone} label={meta.label} />
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-3">Ningún contenedor coincide.</li>}
      </ul>
    </div>
  );
}

function PortainerContainers({ endpointId, serverTitle, endpointName }: { endpointId: number; serverTitle: string; endpointName?: string }) {
  const containers = usePolling(() => api.containers(endpointId), 10_000, [endpointId]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<PortainerContainer | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  async function run(container: PortainerContainer, action: ContainerAction) {
    const verbs: Record<ContainerAction, { confirm: string; done: string }> = {
      start: { confirm: 'Arrancar', done: 'arrancado' },
      stop: { confirm: 'Parar', done: 'parado' },
      restart: { confirm: 'Reiniciar', done: 'reiniciado' },
    };
    if (action !== 'start') {
      const warning = container.isSelf
        ? 'Es el contenedor de este panel: dejarás de verlo hasta que vuelva a arrancar.'
        : container.isPortainer
          ? 'Es Portainer o su agente: perderás el control de los contenedores de este entorno hasta que vuelva.'
          : null;
      const ok = await confirm({
        title: `${verbs[action].confirm} ${container.name}`,
        message: (
          <>
            <p>
              Se va a {verbs[action].confirm.toLowerCase()} <span className="font-mono text-ink">{container.name}</span> en {serverTitle}.
            </p>
            {warning && <p className="mt-2 text-warn">{warning}</p>}
          </>
        ),
        confirmLabel: verbs[action].confirm,
        danger: action === 'stop',
      });
      if (!ok) return;
    }
    setBusy(`${container.id}:${action}`);
    try {
      await api.containerAction(endpointId, container.id, action);
      toast(`${container.name} ${verbs[action].done}`);
      await containers.refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo completar la acción', 'bad');
    } finally {
      setBusy(null);
    }
  }

  if (containers.data === null) {
    return containers.error ? <p className="text-sm text-bad">{containers.error}</p> : <Spinner label="Consultando Portainer" />;
  }

  const visible = filterContainers(containers.data, query, filter);
  const running = containers.data.filter((c) => c.state === 'running').length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-ink">
          Portainer{endpointName ? ` · ${endpointName}` : ''}
        </h3>
        <span className="text-xs text-ink-3">
          {running} de {containers.data.length} en marcha
        </span>
      </div>
      <Toolbar
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        onRefresh={() => void containers.refresh()}
        refreshing={containers.loading}
      />
      {containers.error && <p className="text-xs text-bad">{containers.error} (se muestran los últimos datos)</p>}

      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {visible.map((container) => {
          const meta = containerStateMeta(container);
          const isRunning = container.state === 'running';
          return (
            <li key={container.id} className="px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-ink">{container.name}</span>
                    {container.isSelf && <span className="rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">este panel</span>}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-3" title={container.image}>
                    {container.image}
                  </p>
                </div>
                <StatusBadge tone={meta.tone} label={meta.label} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-xs text-ink-3">{container.status}</span>
                {container.stack && (
                  <span className="rounded border border-line px-1.5 py-px font-mono text-[10px] text-ink-2">stack {container.stack}</span>
                )}
                {container.ports.map((port) => (
                  <span key={port} className="rounded border border-line px-1.5 py-px font-mono text-[10px] text-info/90">
                    {port}
                  </span>
                ))}
                <div className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" icon={<FileText size={13} aria-hidden />} onClick={() => setLogsFor(container)}>
                    Logs
                  </Button>
                  {isRunning ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<RotateCw size={13} aria-hidden />}
                        loading={busy === `${container.id}:restart`}
                        disabled={busy !== null}
                        onClick={() => run(container, 'restart')}
                      >
                        Reiniciar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-bad hover:bg-bad/10 hover:text-bad"
                        icon={<Square size={12} aria-hidden />}
                        loading={busy === `${container.id}:stop`}
                        disabled={busy !== null}
                        onClick={() => run(container, 'stop')}
                      >
                        Parar
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-ok hover:bg-ok/10 hover:text-ok"
                      icon={<Play size={13} aria-hidden />}
                      loading={busy === `${container.id}:start`}
                      disabled={busy !== null}
                      onClick={() => run(container, 'start')}
                    >
                      Arrancar
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-3">Ningún contenedor coincide.</li>}
      </ul>

      {logsFor && <LogsDialog endpointId={endpointId} container={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}

function LogsDialog({ endpointId, container, onClose }: { endpointId: number; container: PortainerContainer; onClose: () => void }) {
  const [tail, setTail] = useState<'100' | '300' | '1000'>('300');
  const [follow, setFollow] = useState(true);
  const logs = usePolling(() => api.containerLogs(endpointId, container.id, Number(tail)), follow ? 5_000 : 0, [tail, follow]);
  const preRef = useRef<HTMLPreElement>(null);
  const text = logs.data === null ? '' : stripAnsi(logs.data).trimEnd();

  useEffect(() => {
    const pre = preRef.current;
    if (pre && follow) pre.scrollTop = pre.scrollHeight;
  }, [text, follow]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={<span className="font-mono">{container.name}</span>}
      description="Logs del contenedor (stdout y stderr)"
      wide
      footer={
        <>
          <Segmented
            label="Líneas"
            value={tail}
            onChange={setTail}
            className="mr-auto"
            options={[
              { value: '100', label: '100' },
              { value: '300', label: '300' },
              { value: '1000', label: '1000' },
            ]}
          />
          <Button variant={follow ? 'secondary' : 'ghost'} aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
            {follow ? 'Siguiendo' : 'Seguir en directo'}
          </Button>
          <Button icon={<RefreshCw size={14} aria-hidden />} onClick={() => void logs.refresh()}>
            Recargar
          </Button>
        </>
      }
    >
      {logs.data === null ? (
        logs.error ? <p className="text-sm text-bad">{logs.error}</p> : <Spinner label="Cargando logs" />
      ) : (
        <pre
          ref={preRef}
          className="scrollbar-thin max-h-[60vh] overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-ink-2"
        >
          {text || 'Sin logs.'}
        </pre>
      )}
    </Dialog>
  );
}
