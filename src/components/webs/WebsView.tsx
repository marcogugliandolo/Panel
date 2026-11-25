import { ChevronLeft, ExternalLink, Filter, Play, RefreshCw, Search, Trash2, Waypoints, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryRange, Monitor, MonitorHistoryPoint, WebIncident, WebTrafficPoint } from '../../../shared/types';
import { api, type DiscoveryState } from '../../api';
import { formatDateTime, formatMs, formatNumber, formatPercent, formatTime, timeAgo } from '../../lib/format';
import { useMediaQuery, usePolling, useStoredState, useWidth } from '../../lib/hooks';
import { MONITOR_META } from '../../lib/status';
import { cn } from '../../lib/utils';
import { NpmDialog } from '../NpmDialog';
import { Button, StatusBadge, useConfirm, useToast } from '../ui';
import { DiscoveryDialog } from './DiscoveryDialog';
import { RouteAnimation, type NodeId } from './RouteAnimation';

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
];

function duration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * Color de una barra de disponibilidad (estado reservado: siempre acompañado del texto en el tooltip).
 * Rojo si en ese tramo hubo un corte (o casi todo falló); amarillo, fallos sueltos.
 */
function uptimeTone(uptime: number | null, hadOutage?: boolean): string {
  if (uptime === null) return 'bg-surface-3';
  if (hadOutage === true) return 'bg-bad';
  // Sin la lista de cortes (minibarras de la lista), una hora casi toda caída cuenta como corte.
  if (hadOutage === undefined && uptime <= 50) return 'bg-bad';
  if (uptime >= 99.95) return 'bg-ok/70';
  return 'bg-warn/80';
}

/** Tooltip sobre la barra, sin salirse por los lados: en los extremos se ancla al borde. */
function tooltipPos(index: number, count: number): React.CSSProperties {
  const pct = ((index + 0.5) / count) * 100;
  if (pct < 18) return { left: 0 };
  if (pct > 82) return { right: 0 };
  return { left: `${pct}%`, transform: 'translate(-50%, -100%)' };
}

/** La sección Webs: elegir una web y ver su ruta, sus cortes y sus visitas reales. */
export function WebsView({
  monitors,
  onChange,
  servers,
  selectedId,
  onSelect,
  now,
}: {
  monitors: Monitor[] | null;
  onChange: () => Promise<void>;
  servers: { serverId: string; title: string }[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  now: number;
}) {
  const bars = usePolling(() => api.webBars(), 60_000);
  const [npmOpen, setNpmOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const discovery = usePolling(() => api.discovery(), 60_000);
  // Mientras busca, se pregunta más a menudo.
  useEffect(() => {
    if (!discovery.data?.running) return;
    const t = window.setInterval(() => void discovery.refresh(), 3000);
    return () => window.clearInterval(t);
  }, [discovery.data?.running, discovery]);
  const wide = useMediaQuery('(min-width: 1024px)');
  // En móvil, la lista y la ficha son dos pantallas: «showDetail» dice cuál se ve.
  const [showDetail, setShowDetail] = useState(false);
  const open = (id: number) => {
    onSelect(id);
    setShowDetail(true);
    window.scrollTo?.({ top: 0 });
  };
  const notWatched = (discovery.data?.candidates ?? []).filter((c) => c.responds).length;
  // «Solo las webs de Nginx Proxy Manager»
  const scope = usePolling(() => api.webScope(), 60_000);
  const confirm = useConfirm();
  const toast = useToast();
  const [seenPruned, setSeenPruned] = useStoredState<number>('panel:webs-quitadas-vistas', 0);
  const npmOnly = scope.data?.npmOnly ?? true;
  const outside = scope.data?.ready ? scope.data.outside : [];
  const lastPruned = scope.data?.lastPruned && scope.data.lastPruned.at > seenPruned && now - scope.data.lastPruned.at < 7 * 86_400_000 ? scope.data.lastPruned : null;
  const listNames = (names: string[]) => (
    <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto font-mono text-[12px] text-ink-2">
      {names.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
  async function setNpmOnly(on: boolean) {
    if (on && outside.length) {
      const ok = await confirm({
        title: 'Solo las webs de Nginx Proxy Manager',
        message: (
          <div>
            <p>
              Se dejan de vigilar {outside.length === 1 ? 'esta web, que no está' : `estas ${outside.length} webs, que no están`} en ningún NPM (se borra su
              historial). A partir de ahora, las que borres de NPM también se quitarán solas.
            </p>
            {listNames(outside.map((m) => m.name))}
          </div>
        ),
        confirmLabel: outside.length === 1 ? 'Quitar 1 web' : `Quitar ${outside.length} webs`,
        danger: true,
      });
      if (!ok) return;
    }
    const st = await api.webScopeSet(on);
    scope.setData(st);
    if (on && outside.length) {
      setSeenPruned(st.lastPruned?.at ?? Date.now());
      toast(outside.length === 1 ? 'Quitada 1 web que no está en NPM' : `Quitadas ${outside.length} webs que no están en NPM`);
    }
    await onChange();
    void bars.refresh();
    void discovery.refresh();
  }
  // Si el panel ha quitado webs (porque se borraron de NPM), la lista se actualiza.
  const prunedAt = scope.data?.lastPruned?.at ?? 0;
  useEffect(() => {
    if (prunedAt) void onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prunedAt]);
  const sorted = useMemo(
    () => [...(monitors ?? [])].sort((a, b) => Number(b.status === 'down') - Number(a.status === 'down') || a.name.localeCompare(b.name)),
    [monitors],
  );
  const selected = sorted.find((m) => m.id === selectedId) ?? null;

  // En pantalla ancha, sin web elegida se abre la primera (la caída, si la hay).
  useEffect(() => {
    if (wide && !selected && sorted.length) onSelect(sorted[0].id);
  }, [wide, selected, sorted, onSelect]);
  // Si se llega con una web ya elegida (desde la campana o la recepción), en móvil se abre su ficha.
  useEffect(() => {
    if (selectedId !== null) setShowDetail(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const detailVisible = wide || (showDetail && selected !== null);
  const listVisible = wide || !detailVisible;

  const down = sorted.filter((m) => m.status === 'down').length;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1500px] gap-4 p-3 sm:p-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:p-6">
        <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start" hidden={!listVisible}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Webs</h2>
            <span className="text-xs text-ink-3">
              {sorted.length} vigiladas{down ? ` · ` : ''}
              {down > 0 && <span className="text-bad">{down} caídas</span>}
            </span>
          </div>
          {lastPruned && (
            <div className="flex items-start gap-2.5 rounded-[12px] border border-line bg-surface px-3 py-2.5">
              <Filter size={14} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
              <p className="min-w-0 flex-1 text-[12px] text-ink-2">
                <span className="font-medium text-ink">
                  {lastPruned.names.length === 1 ? 'Quitada 1 web que no está en NPM' : `Quitadas ${lastPruned.names.length} webs que no están en NPM`}
                </span>{' '}
                <span className="text-ink-3">· {timeAgo(lastPruned.at, now)}</span>
                <span className="mt-0.5 block break-words text-ink-3">{lastPruned.names.join(', ')}</span>
              </p>
              <button type="button" aria-label="Cerrar aviso" onClick={() => setSeenPruned(lastPruned.at)} className="-m-1 rounded p-1 text-ink-3 hover:bg-white/5 hover:text-ink">
                <X size={13} aria-hidden />
              </button>
            </div>
          )}
          {!npmOnly && outside.length > 0 && (
            <button
              type="button"
              onClick={() => void setNpmOnly(true)}
              className="flex w-full items-center gap-2.5 rounded-[12px] border border-warn/30 bg-warn/[0.06] px-3 py-2.5 text-left transition-colors hover:bg-warn/[0.1]"
            >
              <Filter size={15} className="shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">
                  {outside.length === 1 ? '1 web no está en NPM' : `${outside.length} webs no están en NPM`}
                </span>
                <span className="block text-[11.5px] text-ink-3">Quitarlas y vigilar solo las de Nginx Proxy Manager</span>
              </span>
            </button>
          )}
          {npmOnly ? null : notWatched > 0 ? (
            <button
              type="button"
              onClick={() => setFindOpen(true)}
              className="flex w-full items-center gap-2.5 rounded-[12px] border border-accent/30 bg-accent/[0.07] px-3 py-2.5 text-left transition-colors hover:bg-accent/[0.11]"
            >
              <Search size={15} className="shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">
                  {notWatched} {notWatched === 1 ? 'web tuya sin vigilar' : 'webs tuyas sin vigilar'}
                </span>
                <span className="block text-[11.5px] text-ink-3">Encontradas en tus certificados y en NPM · Revisar</span>
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setFindOpen(true)}
              className="flex w-full items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-left text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:bg-white/[0.03] hover:text-ink"
            >
              <Search size={14} className={cn('shrink-0 text-ink-3', discovery.data?.running && 'animate-pulse')} aria-hidden />
              <span className="flex-1">{discovery.data?.running ? 'Buscando tus webs…' : 'Buscar todas tus webs'}</span>
              {discovery.data?.lastRun && <span className="text-[11px] text-ink-3">{timeAgo(discovery.data.lastRun, now)}</span>}
            </button>
          )}
          <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
            {monitors === null && <li className="px-3 py-3 text-sm text-ink-3">Cargando…</li>}
            {monitors?.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">Aún no hay webs vigiladas.</li>}
            {sorted.map((m) => {
              const meta = MONITOR_META[m.status];
              const active = m.id === selectedId;
              const row = bars.data?.[m.id];
              return (
                <li key={m.id} className="border-t border-line first:border-t-0">
                  <button
                    type="button"
                    onClick={() => open(m.id)}
                    aria-current={(active && wide) || undefined}
                    className={cn('w-full px-3 py-3 text-left transition-colors lg:py-2.5', active && wide ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.name}</span>
                      <StatusBadge tone={meta.tone} label={meta.label} />
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <span className="flex h-3.5 flex-1 items-end gap-[2px]" aria-hidden>
                        {(row ?? Array.from({ length: 24 }, () => ({ t: 0, uptime: null }))).map((b, i) => (
                          <span key={i} className={cn('h-full flex-1 rounded-[2px]', uptimeTone(b.uptime))} />
                        ))}
                      </span>
                      <span className="w-12 text-right font-mono text-[11px] text-ink-3">{formatPercent(m.uptime24h, 1)}</span>
                    </span>
                    {m.status === 'down' && m.diagnosis && !m.diagnosis.ok && (
                      <span className="mt-1 block truncate text-[11.5px] font-medium text-bad">{m.diagnosis.title}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => setNpmOpen(true)}
            className="flex w-full items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-left text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:bg-white/[0.03] hover:text-ink"
          >
            <Waypoints size={14} className="shrink-0 text-ink-3" aria-hidden />
            Nginx Proxy Manager
          </button>
          {scope.data && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] px-1 py-1 text-[12.5px]">
              <input
                type="checkbox"
                checked={npmOnly}
                onChange={(e) => void setNpmOnly(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-ink-2">Solo las webs de Nginx Proxy Manager</span>
                <span className="block text-[11.5px] text-ink-3">
                  {npmOnly
                    ? scope.data.ready
                      ? 'Las que borres de NPM dejan de vigilarse solas.'
                      : 'Aún no llegan los datos de NPM: no se quita nada hasta entonces.'
                    : 'Desactivado: puedes vigilar webs que no estén en NPM y buscarlas en tus certificados.'}
                </span>
              </span>
            </label>
          )}
          <p className="text-[11.5px] text-ink-3">Barras: últimas 24 horas, una por hora.</p>
        </aside>

        <div className="min-w-0" hidden={!detailVisible}>
          {!wide && (
            <button type="button" onClick={() => setShowDetail(false)} className="mb-3 inline-flex items-center gap-1 py-1 text-[13px] text-ink-2 hover:text-ink">
              <ChevronLeft size={16} aria-hidden /> Todas las webs
            </button>
          )}
          {selected ? (
            <WebDetail
              key={selected.id}
              monitor={selected}
              onChange={onChange}
              onRemoved={() => {
                onSelect(null);
                setShowDetail(false);
              }}
              now={now}
            />
          ) : (
            <div className="rounded-[14px] border border-line bg-surface p-8 text-center text-sm text-ink-3">Elige una web de la lista.</div>
          )}
        </div>
      </div>
      <NpmDialog open={npmOpen} onClose={() => setNpmOpen(false)} servers={servers} onImported={() => void onChange()} />
      <DiscoveryDialog
        open={findOpen}
        onClose={() => setFindOpen(false)}
        state={discovery.data}
        onState={(st: DiscoveryState) => discovery.setData(st)}
        onWatched={() => {
          void onChange();
          void bars.refresh();
        }}
      />
    </div>
  );
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2.5 sm:px-4">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'ok' }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-line bg-surface px-3 py-2.5 sm:px-4 sm:py-3">
      <p className="truncate text-[11.5px] text-ink-3">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums sm:text-xl">
        {tone && <span className={cn('size-2 rounded-full', tone === 'bad' ? 'bg-bad' : 'bg-ok')} aria-hidden />}
        {value}
      </p>
    </div>
  );
}

function WebDetail({ monitor, onChange, onRemoved, now }: { monitor: Monitor; onChange: () => Promise<void>; onRemoved: () => void; now: number }) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const history = usePolling(() => api.monitorHistory(monitor.id, range), 60_000, [range]);
  const incidents = usePolling(() => api.webIncidents(monitor.id, range), 60_000, [range]);
  const traffic = usePolling(() => api.webTraffic(monitor.id, range), 60_000, [range]);
  const [tracing, setTracing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [node, setNode] = useState<NodeId | null>(null);
  const [fresh, setFresh] = useState<Monitor['diagnosis']>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const diagnosis = fresh && (!monitor.diagnosis || fresh.at >= monitor.diagnosis.at) ? fresh : monitor.diagnosis;
  const meta = MONITOR_META[monitor.status];

  async function trace(quiet = false) {
    setTracing(true);
    try {
      const result = await api.diagnoseMonitor(monitor.id);
      setFresh(result.diagnosis);
      setNode(null);
      await onChange();
    } catch (error) {
      if (!quiet) toast(error instanceof Error ? error.message : 'No se pudo seguir la ruta', 'bad');
    } finally {
      setTracing(false);
    }
  }

  // Al abrir una web se sigue su ruta si no hay un diagnóstico reciente.
  const traced = useRef(false);
  useEffect(() => {
    if (traced.current) return;
    traced.current = true;
    if (!monitor.diagnosis || Date.now() - monitor.diagnosis.at > 5 * 60_000) void trace(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function check() {
    setChecking(true);
    try {
      const result = await api.checkMonitor(monitor.id);
      const ok = Boolean(result.lastCheck?.ok);
      toast(ok ? `Responde en ${formatMs(result.lastCheck?.latencyMs ?? null)}` : (result.lastCheck?.error ?? 'No responde'), ok ? 'ok' : 'bad');
      await Promise.all([onChange(), history.refresh(), incidents.refresh()]);
    } finally {
      setChecking(false);
    }
  }

  async function start() {
    const action = diagnosis?.action;
    if (!action) return;
    setStarting(true);
    try {
      await api.containerAction(action.endpointId, action.container, 'start');
      toast(`${action.container} arrancado en ${action.serverName}. Comprobando la web…`);
      await new Promise((r) => setTimeout(r, 6000));
      await api.checkMonitor(monitor.id).catch(() => undefined);
      await trace();
      await Promise.all([history.refresh(), incidents.refresh()]);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo arrancar', 'bad');
    } finally {
      setStarting(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Dejar de vigilar ${monitor.name}`,
      message: <p>Se borran su historial y sus cortes. Si viene de Nginx Proxy Manager, no se volverá a añadir sola.</p>,
      confirmLabel: 'Dejar de vigilar',
      danger: true,
    });
    if (!ok) return;
    await api.deleteMonitor(monitor.id);
    toast(`${monitor.name} ya no se vigila`);
    onRemoved();
    await onChange();
  }

  const list = incidents.data ?? [];
  const downtime = list.reduce((acc, i) => acc + i.durationMs, 0);
  const uptime = useMemo(() => {
    const pts = history.data?.points ?? [];
    const checks = pts.reduce((a, p) => a + p.checks, 0);
    if (!checks) return null;
    return pts.reduce((a, p) => a + (p.uptime ?? 0) * p.checks, 0) / checks;
  }, [history.data]);
  const shownNode = node ?? diagnosis?.failedAt ?? null;
  const step = diagnosis?.steps.find((s) => s.id === node) ?? null;

  return (
    <div className="space-y-4">
      {/* Cabecera */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-lg font-semibold">{monitor.name}</h2>
            <StatusBadge tone={meta.tone} label={meta.label} />
          </div>
          <a href={monitor.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-xs break-all text-ink-3 hover:text-ink">
            {monitor.url} <ExternalLink size={11} aria-hidden />
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={checking} onClick={check}>
            Comprobar ahora
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden />} onClick={remove}>
            Dejar de vigilar
          </Button>
        </div>
      </div>

      {/* La ruta */}
      <Card
        title="Ruta de una visita"
        aside={
          <button type="button" onClick={() => trace()} disabled={tracing} className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink disabled:opacity-60">
            <RefreshCw size={12} className={cn(tracing && 'animate-spin')} aria-hidden />
            {tracing ? 'Siguiendo la ruta…' : diagnosis ? `Comprobada ${timeAgo(diagnosis.at, now)} · repetir` : 'Seguir la ruta'}
          </button>
        }
      >
        <RouteAnimation diagnosis={tracing && !diagnosis ? null : diagnosis} tracing={tracing} selected={shownNode} onSelect={setNode} />
        {diagnosis ? (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            <div className={cn('min-w-0 rounded-[10px] border px-3 py-2.5', diagnosis.ok ? 'border-ok/25 bg-ok/[0.06]' : 'border-bad/30 bg-bad/[0.07]')}>
              <p className={cn('text-[13px] font-semibold', diagnosis.ok ? 'text-ok' : 'text-bad')}>{diagnosis.title}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{diagnosis.summary}</p>
              {diagnosis.action && (
                <Button variant="primary" size="sm" className="mt-2.5 h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal" loading={starting} icon={<Play size={13} aria-hidden />} onClick={start}>
                  Arrancar {diagnosis.action.container} en {diagnosis.action.serverName}
                </Button>
              )}
            </div>
            {/* En el móvil la ruta en vertical ya explica cada paso: la lista solo sale al tocar uno */}
            <div className={cn('min-w-0 rounded-[10px] border border-line px-3 py-2.5', !(step && node) && 'max-sm:hidden')}>
              {step && node ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-medium">{step.label}</p>
                    <button type="button" onClick={() => setNode(null)} className="text-[11.5px] text-ink-3 hover:text-ink">
                      Ver todos los pasos
                    </button>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{step.detail}</p>
                </>
              ) : (
                <ul className="space-y-1">
                  {diagnosis.steps.map((st) => (
                    <li key={st.id}>
                      <button type="button" onClick={() => setNode(st.id)} title={st.detail} className="flex w-full items-baseline gap-2 text-left text-[12px] hover:text-ink">
                        <span
                          className={cn(
                            'size-1.5 shrink-0 translate-y-[-1px] rounded-full',
                            st.status === 'ok' ? 'bg-ok' : st.status === 'fail' ? 'bg-bad' : st.status === 'warn' ? 'bg-warn' : 'bg-surface-3',
                          )}
                          aria-hidden
                        />
                        <span className="w-[86px] shrink-0 truncate font-medium text-ink-2">{st.label}</span>
                        <span className={cn('truncate', st.status === 'skip' ? 'text-ink-3/70' : 'text-ink-3')}>{st.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-[12.5px] text-ink-3">{tracing ? 'Siguiendo el camino de una visita…' : 'Aún no se ha seguido la ruta de esta web.'}</p>
        )}
      </Card>

      {/* Resumen del periodo */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Historial</h3>
        <div role="group" aria-label="Periodo" className="flex rounded-lg border border-line p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
              className={cn('rounded-md px-2.5 py-1 text-xs font-semibold transition-colors', range === r.value ? 'bg-white/10 text-white' : 'text-ink-3 hover:text-ink')}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <Stat label="Disponibilidad" value={uptime === null ? '—' : formatPercent(uptime, 2)} />
        <Stat label="Cortes" value={incidents.data ? String(list.length) : '—'} tone={list.some((i) => !i.endedAt) ? 'bad' : undefined} />
        <Stat label="Tiempo caída" value={incidents.data ? (downtime ? duration(downtime) : '0 min') : '—'} />
        <Stat
          label="Visitas reales fallidas"
          value={traffic.data?.lastAt ? `${formatNumber(traffic.data.totals.failed)} de ${formatNumber(traffic.data.totals.requests)}` : '—'}
        />
      </div>

      <Card title="Disponibilidad" aside={<span className="text-xs text-ink-3">Cada barra es un tramo del periodo</span>}>
        <UptimeBars points={history.data?.points ?? null} bucketMs={history.data?.bucketMs ?? 0} incidents={list} range={range} now={now} />
      </Card>

      <Card title="Cortes" aside={<span className="text-xs text-ink-3">Dos comprobaciones fallidas seguidas abren un corte</span>}>
        <IncidentList incidents={incidents.data} now={now} />
      </Card>

      <Card title="Visitas reales" aside={<span className="text-xs text-ink-3">De los logs de Nginx Proxy Manager</span>}>
        <TrafficChart traffic={traffic.data} range={range} now={now} />
      </Card>
    </div>
  );
}

/** Barras de disponibilidad del periodo (96 tramos), con tooltip al pasar por encima. */
function UptimeBars({
  points,
  bucketMs,
  incidents,
  range,
  now,
}: {
  points: MonitorHistoryPoint[] | null;
  bucketMs: number;
  incidents: WebIncident[];
  range: HistoryRange;
  now: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, width] = useWidth<HTMLDivElement>();
  // En pantallas estrechas se juntan los tramos de dos en dos (o de cuatro en cuatro) para que se vean.
  const group = width && width < 360 ? 4 : width && width < 620 ? 2 : 1;
  const span = bucketMs * group;
  const slots = useMemo(() => {
    if (!points || !bucketMs) return null;
    const count = 96 / group;
    const last = Math.floor(now / span) * span;
    const byT = new Map(points.map((p) => [p.t, p]));
    return Array.from({ length: count }, (_, i) => {
      const t = last - (count - 1 - i) * span;
      const parts = Array.from({ length: group }, (_, k) => byT.get(t + k * bucketMs)).filter(Boolean) as MonitorHistoryPoint[];
      const checks = parts.reduce((a, p) => a + p.checks, 0);
      const point: MonitorHistoryPoint | null = checks
        ? {
            t,
            checks,
            uptime: parts.reduce((a, p) => a + (p.uptime ?? 0) * p.checks, 0) / checks,
            latency: parts.some((p) => p.latency) ? Math.round(parts.reduce((a, p) => a + (p.latency ?? 0), 0) / parts.filter((p) => p.latency).length) : null,
          }
        : null;
      const outage = incidents.find((inc) => inc.startedAt < t + span && (inc.endedAt ?? now) > t) ?? null;
      return { t, point, outage };
    });
  }, [points, bucketMs, incidents, now, group, span]);

  if (!slots) return <div ref={boxRef} className="h-12 animate-pulse rounded-md bg-surface-2" />;
  const h = slots[hover ?? -1];
  const withDate = range !== '24h';
  return (
    <div className="relative" ref={boxRef}>
      <div className="flex h-12 items-stretch gap-[2px]" onMouseLeave={() => setHover(null)}>
        {slots.map((s, i) => (
          <button
            key={s.t}
            type="button"
            aria-label={`${formatTime(s.t, withDate)}: ${s.point ? `${formatPercent(s.point.uptime, 1)} disponible` : 'sin datos'}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            className="group flex flex-1 items-end"
          >
            <span
              className={cn('block h-full w-full rounded-[3px] transition-opacity', uptimeTone(s.point?.uptime ?? null, Boolean(s.outage)), hover !== null && hover !== i && 'opacity-60')}
            />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-ink-3">
        <span>{formatTime(slots[0].t, withDate)}</span>
        <span>ahora</span>
      </div>
      {h && (
        <div
          className="pointer-events-none absolute -top-2 z-10 w-max max-w-[220px] -translate-y-full rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-[11.5px] shadow-xl"
          style={tooltipPos(hover!, slots.length)}
        >
          <p className="font-medium text-ink">
            {formatTime(h.t, withDate)} – {formatTime(h.t + span, withDate)}
          </p>
          {h.point ? (
            <p className="text-ink-2">
              {formatPercent(h.point.uptime, 1)} disponible · {h.point.checks} comprobaciones{h.point.latency ? ` · ${formatMs(h.point.latency)}` : ''}
            </p>
          ) : (
            <p className="text-ink-3">Sin comprobaciones</p>
          )}
          {h.outage && (
            <p className="mt-0.5 text-ink-2">
              Corte de {duration(h.outage.durationMs)}
              {h.outage.cause ? `: ${h.outage.cause.title.toLowerCase()}` : ''}
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-ok/70" aria-hidden /> Responde</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-warn/80" aria-hidden /> Fallos sueltos</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-bad" aria-hidden /> Hubo un corte</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-surface-3" aria-hidden /> Sin datos</span>
      </div>
    </div>
  );
}

function IncidentList({ incidents, now }: { incidents: WebIncident[] | null; now: number }) {
  if (!incidents) return <div className="h-16 animate-pulse rounded-md bg-surface-2" />;
  if (!incidents.length) return <p className="text-[13px] text-ink-3">Ningún corte en este periodo.</p>;
  const day = (ts: number) => {
    const d = new Date(ts);
    const today = new Date(now);
    if (d.toDateString() === today.toDateString()) return `Hoy ${formatTime(ts)}`;
    const y = new Date(now - 86_400_000);
    if (d.toDateString() === y.toDateString()) return `Ayer ${formatTime(ts)}`;
    return formatDateTime(ts);
  };
  return (
    <ol className="space-y-0">
      {incidents.map((inc) => {
        const ongoing = inc.endedAt === null;
        return (
          <li key={inc.id} className="relative flex gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
            <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', ongoing ? 'animate-pulse bg-bad' : 'bg-bad/60')} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="font-medium text-ink">
                  {day(inc.startedAt)} → {ongoing ? 'sigue caída' : formatTime(inc.endedAt!)}
                </span>
                <span className="font-mono text-[11.5px] text-ink-3">{duration(inc.durationMs)}</span>
                {ongoing && <StatusBadge tone="bad" label="En curso" />}
              </p>
              {inc.cause ? (
                <p className="mt-0.5 text-[12.5px] text-ink-2">
                  <span className="font-medium text-ink">{inc.cause.title}.</span> {inc.cause.summary}
                </p>
              ) : (
                <p className="mt-0.5 text-[12.5px] text-ink-3">{inc.error ?? 'No respondía'} (no se llegó a diagnosticar la ruta)</p>
              )}
              {inc.failedVisits !== null && inc.failedVisits > 0 && (
                <p className="mt-0.5 text-[12px] text-ink-3">
                  {formatNumber(inc.failedVisits)} {inc.failedVisits === 1 ? 'visita real falló' : 'visitas reales fallaron'} durante el corte
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Visitas por tramo: las que fueron bien abajo, las fallidas encima (en rojo), con un hueco de 2 px entre ambas. */
function TrafficChart({ traffic, range, now }: { traffic: import('../../../shared/types').WebTraffic | null; range: HistoryRange; now: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const group = width && width < 360 ? 4 : width && width < 620 ? 2 : 1;
  const span = (traffic?.bucketMs ?? 0) * group;
  const slots = useMemo(() => {
    if (!traffic?.bucketMs) return null;
    const count = 96 / group;
    const last = Math.floor(now / span) * span;
    const byT = new Map(traffic.points.map((p) => [p.t, p]));
    return Array.from({ length: count }, (_, i) => {
      const t = last - (count - 1 - i) * span;
      const acc: WebTrafficPoint = { t, requests: 0, failed: 0, gateway: 0 };
      for (let k = 0; k < group; k++) {
        const p = byT.get(t + k * traffic.bucketMs);
        if (p) {
          acc.requests += p.requests;
          acc.failed += p.failed;
          acc.gateway += p.gateway;
        }
      }
      return acc;
    });
  }, [traffic, now, group, span]);

  if (!traffic || !slots) return <div ref={boxRef} className="h-40 animate-pulse rounded-md bg-surface-2" />;
  if (!traffic.lastAt) {
    return (
      <p ref={boxRef} className="text-[13px] text-ink-3">
        Aún no llegan visitas de esta web. Se leen de los logs de Nginx Proxy Manager: actualiza el script de métricas en el servidor donde está NPM y en
        un minuto empezarán a aparecer.
      </p>
    );
  }
  const max = Math.max(1, ...slots.map((s) => s.requests));
  const nice = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    const m = max / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  })();
  const H = 140;
  const withDate = range !== '24h';
  const h = hover !== null ? slots[hover] : null;
  return (
    <div ref={boxRef}>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-info" aria-hidden /> Visitas que fueron bien</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-bad" aria-hidden /> Visitas con error (5xx)</span>
        <span className="text-ink-3 sm:ml-auto">Último dato {timeAgo(traffic.lastAt, now)}</span>
      </div>
      <div className="relative flex gap-2">
        <div className="flex flex-col justify-between py-0 text-right font-mono text-[10.5px] text-ink-3" style={{ height: H }}>
          <span>{formatNumber(nice)}</span>
          <span>{formatNumber(nice / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-line" />
          <div className="pointer-events-none absolute inset-x-0 border-t border-line" style={{ top: H / 2 }} />
          <div className="flex items-end gap-[2px] border-b border-line-strong" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {slots.map((s, i) => {
              const okH = ((s.requests - s.failed) / nice) * H;
              const badH = (s.failed / nice) * H;
              return (
                <button
                  key={s.t}
                  type="button"
                  aria-label={`${formatTime(s.t, withDate)}: ${s.requests} visitas, ${s.failed} con error`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  className="flex h-full flex-1 flex-col items-stretch justify-end"
                >
                  {s.failed > 0 && <span className="block rounded-t-[3px] bg-bad" style={{ height: Math.max(2, badH) }} />}
                  {s.failed > 0 && okH > 0 && <span className="block h-[2px] shrink-0" />}
                  {okH > 0 && (
                    <span
                      className={cn('block bg-info transition-opacity', s.failed === 0 && 'rounded-t-[3px]', hover !== null && hover !== i && 'opacity-60')}
                      style={{ height: Math.max(1, okH) }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-ink-3">
            <span>{formatTime(slots[0].t, withDate)}</span>
            <span>ahora</span>
          </div>
          {h && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-max max-w-[220px] -translate-y-full rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-[11.5px] shadow-xl"
              style={tooltipPos(hover!, slots.length)}
            >
              <p className="font-medium text-ink">
                {formatTime(h.t, withDate)} – {formatTime(h.t + span, withDate)}
              </p>
              <p className="text-ink-2">{formatNumber(h.requests)} visitas</p>
              {h.failed > 0 && (
                <p className="text-ink-2">
                  {formatNumber(h.failed)} con error{h.gateway ? ` (${formatNumber(h.gateway)} de NPM sin llegar al contenedor)` : ''}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
