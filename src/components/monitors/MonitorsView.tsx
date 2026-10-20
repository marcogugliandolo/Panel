import { ChevronDown, ExternalLink, Globe2, Pause, Pencil, Play, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { THRESHOLDS, type HistoryRange, type Monitor } from '../../../shared/types';
import { api } from '../../api';
import { daysUntil, formatDateTime, formatMs, formatPercent, formatTime, timeAgo } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { MONITOR_META, TONE_COLOR } from '../../lib/status';
import { cn } from '../../lib/utils';
import { Button, EmptyState, IconButton, Segmented, Spinner, StatusBadge, useConfirm, useToast } from '../ui';
import { MonitorDialog } from './MonitorDialog';

const SERIES_COLOR = '#3987e5';
const GRID_COLOR = '#202228';
const AXIS_COLOR = '#6e737c';
const ORDER = { down: 0, warning: 1, pending: 2, up: 3, paused: 4 } as const;

export function MonitorsView({
  monitors,
  error,
  onChange,
  focusId,
  now,
}: {
  monitors: Monitor[] | null;
  error: string | null;
  onChange: () => Promise<void>;
  focusId: number | null;
  now: number;
}) {
  const [editing, setEditing] = useState<Monitor | 'new' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(focusId);

  useEffect(() => {
    if (focusId !== null) {
      setExpanded(focusId);
      document.getElementById(`monitor-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusId]);

  if (monitors === null) {
    return error ? <p className="p-6 text-sm text-bad">{error}</p> : <Spinner label="Cargando webs" />;
  }

  const sorted = [...monitors].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
  const counts = monitors.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }), {});

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Webs</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">
            {monitors.length === 0
              ? 'Comprueba que tus webs responden y que sus certificados no caducan.'
              : [
                  counts.up && `${counts.up} ${counts.up === 1 ? 'operativa' : 'operativas'}`,
                  counts.down && `${counts.down} ${counts.down === 1 ? 'caída' : 'caídas'}`,
                  counts.warning && `${counts.warning} con fallos puntuales`,
                  counts.paused && `${counts.paused} en pausa`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setEditing('new')}>
          Añadir web
        </Button>
      </div>

      {monitors.length === 0 ? (
        <EmptyState
          icon={<Globe2 size={28} aria-hidden />}
          title="Aún no vigilas ninguna web"
          action={
            <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setEditing('new')}>
              Añadir la primera
            </Button>
          }
        >
          Añade, por ejemplo, vaixataxi.es: el panel la comprobará cada minuto y te avisará si deja de responder.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {sorted.map((monitor) => (
            <MonitorCard
              key={monitor.id}
              monitor={monitor}
              now={now}
              expanded={expanded === monitor.id}
              onToggle={() => setExpanded((id) => (id === monitor.id ? null : monitor.id))}
              onEdit={() => setEditing(monitor)}
              onChange={onChange}
            />
          ))}
        </ul>
      )}

      {editing && (
        <MonitorDialog
          monitor={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            setExpanded(saved.id);
            await onChange();
          }}
        />
      )}
    </div>
  );
}

function CertificateInfo({ monitor, now }: { monitor: Monitor; now: number }) {
  const cert = monitor.cert;
  if (!cert) return <span className="text-ink-3">Sin HTTPS</span>;
  if (cert.error && !cert.expiresAt) return <span className="text-bad">{cert.error}</span>;
  if (!cert.expiresAt) return <span className="text-ink-3">Pendiente</span>;
  const days = daysUntil(cert.expiresAt, now);
  const tone = cert.error || days < 3 ? 'text-bad' : days < THRESHOLDS.certDays ? 'text-warn' : 'text-ink';
  const Icon = cert.error || days < THRESHOLDS.certDays ? ShieldAlert : ShieldCheck;
  return (
    <span className={cn('inline-flex items-center gap-1', tone)} title={`${cert.issuer ?? ''} · caduca el ${formatDateTime(cert.expiresAt)}`}>
      <Icon size={13} aria-hidden />
      {days < 0 ? `Caducó hace ${-days} d` : `Caduca en ${days} d`}
    </span>
  );
}

function MonitorCard({
  monitor,
  now,
  expanded,
  onToggle,
  onEdit,
  onChange,
}: {
  monitor: Monitor;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onChange: () => Promise<void>;
}) {
  const meta = MONITOR_META[monitor.status];
  const [busy, setBusy] = useState<'check' | 'pause' | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const okCount = monitor.recent.filter((c) => c.ok).length;
  let host = monitor.url;
  try {
    host = new URL(monitor.url).host;
  } catch {
    /* URL guardada ya validada */
  }

  async function action(kind: 'check' | 'pause') {
    setBusy(kind);
    try {
      if (kind === 'check') {
        const result = await api.checkMonitor(monitor.id);
        toast(result.lastCheck?.ok ? `${monitor.name} responde (${formatMs(result.lastCheck.latencyMs)})` : `${monitor.name}: ${result.lastCheck?.error ?? 'falla'}`, result.lastCheck?.ok ? 'ok' : 'bad');
      } else {
        await api.updateMonitor(monitor.id, { enabled: !monitor.enabled });
        toast(monitor.enabled ? `${monitor.name} en pausa` : `${monitor.name} reanudada`);
      }
      await onChange();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo completar', 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Eliminar ${monitor.name}`,
      message: 'Se dejará de comprobar esta web y se borrará su historial.',
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMonitor(monitor.id);
      toast(`${monitor.name} eliminada`);
      await onChange();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo eliminar', 'bad');
    }
  }

  return (
    <li id={`monitor-${monitor.id}`} className={cn('scroll-mt-24 rounded-xl border bg-surface', monitor.status === 'down' ? 'border-bad/30' : 'border-line')}>
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="truncate text-[15px] font-semibold">{monitor.name}</h2>
              <StatusBadge tone={meta.tone} label={meta.label} />
            </div>
            <a
              href={monitor.url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-ink-3 hover:text-info"
            >
              {host}
              <ExternalLink size={11} aria-hidden />
            </a>
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton label="Comprobar ahora" onClick={() => action('check')} disabled={busy !== null}>
              <RefreshCw size={15} className={cn(busy === 'check' && 'animate-spin')} />
            </IconButton>
            <IconButton label={monitor.enabled ? 'Pausar' : 'Reanudar'} onClick={() => action('pause')} disabled={busy !== null}>
              {monitor.enabled ? <Pause size={15} /> : <Play size={15} />}
            </IconButton>
            <IconButton label="Editar" onClick={onEdit}>
              <Pencil size={15} />
            </IconButton>
            <IconButton label="Eliminar" onClick={remove} className="hover:text-bad">
              <Trash2 size={15} />
            </IconButton>
          </div>
        </div>

        {monitor.lastCheck && !monitor.lastCheck.ok && monitor.enabled && (
          <p className="mt-2 text-[13px] text-bad">{monitor.lastCheck.error}</p>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-5">
          <div>
            <dt className="label-caps">Uptime 24 h</dt>
            <dd className="mt-0.5 font-medium">{formatPercent(monitor.uptime24h, 2)}</dd>
          </div>
          <div>
            <dt className="label-caps">Uptime 7 d</dt>
            <dd className="mt-0.5 font-medium">{formatPercent(monitor.uptime7d, 2)}</dd>
          </div>
          <div>
            <dt className="label-caps">Respuesta media</dt>
            <dd className="mt-0.5 font-medium">{formatMs(monitor.avgLatency24h)}</dd>
          </div>
          <div>
            <dt className="label-caps">Certificado</dt>
            <dd className="mt-0.5 font-medium">
              <CertificateInfo monitor={monitor} now={now} />
            </dd>
          </div>
          <div>
            <dt className="label-caps">Comprobada</dt>
            <dd className="mt-0.5 font-medium text-ink-2">{monitor.lastCheck ? timeAgo(monitor.lastCheck.ts, now) : '—'}</dd>
          </div>
        </dl>

        {monitor.recent.length > 0 && (
          <div className="mt-4">
            <p className="sr-only">
              Últimas {monitor.recent.length} comprobaciones: {okCount} correctas.
            </p>
            <div className="flex h-5 items-stretch gap-[2px]" aria-hidden>
              {Array.from({ length: Math.max(0, 30 - monitor.recent.length) }).map((_, i) => (
                <span key={`empty-${i}`} className="flex-1 rounded-[2px] bg-white/[0.04]" />
              ))}
              {monitor.recent.map((check) => (
                <span
                  key={check.ts}
                  className={cn('flex-1 rounded-[2px] transition-opacity hover:opacity-100', check.ok ? 'opacity-45' : 'opacity-95')}
                  style={{ backgroundColor: TONE_COLOR[check.ok ? 'ok' : 'bad'] }}
                  title={`${formatDateTime(check.ts)} · ${check.ok ? formatMs(check.latencyMs) : 'fallo'}`}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-ink-3">
              <span>{monitor.recent.length === 1 ? 'Última comprobación' : `Últimas ${monitor.recent.length} comprobaciones`}</span>
              <span>ahora</span>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-center gap-1.5 border-t border-line py-2 text-xs text-ink-3 transition-colors hover:bg-white/[0.03] hover:text-ink-2"
      >
        {expanded ? 'Ocultar historial' : 'Ver historial'}
        <ChevronDown size={14} className={cn('transition-transform', expanded && 'rotate-180')} aria-hidden />
      </button>
      {expanded && <MonitorHistoryPanel monitor={monitor} now={now} />}
    </li>
  );
}

const RANGES: { value: HistoryRange; label: string; ms: number }[] = [
  { value: '24h', label: '24 h', ms: 86_400_000 },
  { value: '7d', label: '7 d', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 d', ms: 30 * 86_400_000 },
];

function MonitorHistoryPanel({ monitor, now }: { monitor: Monitor; now: number }) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const history = usePolling(() => api.monitorHistory(monitor.id, range), 60_000, [monitor.id, range, monitor.lastCheck?.ts]);
  const span = RANGES.find((r) => r.value === range)!.ms;
  const withDate = span > 86_400_000;

  return (
    <div className="space-y-4 border-t border-line p-4">
      <Segmented label="Periodo" value={range} onChange={setRange} options={RANGES.map(({ value, label }) => ({ value, label }))} />
      {history.data === null ? (
        history.error ? <p className="text-sm text-bad">{history.error}</p> : <Spinner label="Cargando historial" />
      ) : (
        <>
          <figure>
            <figcaption className="mb-1.5 text-[13px] font-medium">Tiempo de respuesta</figcaption>
            {history.data.points.some((p) => p.latency !== null) ? (
              <div className="h-[150px]">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 140 }}>
                  <AreaChart data={history.data.points} margin={{ top: 6, right: 6, bottom: 0, left: -8 }}>
                    <CartesianGrid vertical={false} stroke={GRID_COLOR} />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={[now - span, now]}
                      tickFormatter={(t: number) => formatTime(t, withDate)}
                      tick={{ fill: AXIS_COLOR, fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: GRID_COLOR }}
                      minTickGap={40}
                    />
                    <YAxis
                      tickFormatter={(v: number) => formatMs(v)}
                      tick={{ fill: AXIS_COLOR, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={66}
                    />
                    <Tooltip
                      cursor={{ stroke: 'rgb(255 255 255 / 0.25)', strokeWidth: 1 }}
                      isAnimationActive={false}
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const point = payload[0]?.payload as { latency: number | null; uptime: number | null; checks: number };
                        return (
                          <div className="rounded-lg border border-line bg-surface-3 px-3 py-2 shadow-xl shadow-black/50">
                            <div className="flex items-center gap-2">
                              <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: SERIES_COLOR }} aria-hidden />
                              <span className="text-sm font-semibold">{formatMs(point.latency)}</span>
                              <span className="text-xs text-ink-2">respuesta media</span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-ink-3">
                              {formatTime(Number(label), true)} · {formatPercent(point.uptime, 1)} disponible · {point.checks} comprobaciones
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="latency"
                      stroke={SERIES_COLOR}
                      strokeWidth={2}
                      fill={SERIES_COLOR}
                      fillOpacity={0.1}
                      isAnimationActive={false}
                      dot={false}
                      activeDot={{ r: 4, fill: SERIES_COLOR, stroke: 'var(--color-surface)', strokeWidth: 2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-[13px] text-ink-3">Sin respuestas correctas en este periodo.</p>
            )}
          </figure>

          <div>
            <h3 className="mb-2 text-[13px] font-medium">Fallos en el periodo</h3>
            {history.data.failures.length === 0 ? (
              <p className="text-[13px] text-ink-3">Ningún fallo en este periodo.</p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line text-[13px]">
                {history.data.failures.map((failure) => (
                  <li key={failure.ts} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                    <span className="text-bad">{failure.error ?? 'Error'}</span>
                    <span className="tabular-nums text-ink-3">{formatDateTime(failure.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
