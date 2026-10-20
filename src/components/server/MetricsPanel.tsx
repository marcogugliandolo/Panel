import { Table2, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { THRESHOLDS, type HistoryRange, type MetricPoint, type ServerStats } from '../../../shared/types';
import { api } from '../../api';
import { formatDuration, formatPercent, formatTime, timeAgo } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { EmptyState, Meter, Segmented, Spinner } from '../ui';

// Una sola serie por gráfica: azul de datos (validado contra la superficie oscura), nunca un color de estado.
const SERIES_COLOR = '#3987e5';
const GRID_COLOR = '#202228';
const AXIS_COLOR = '#6e737c';

const RANGES: { value: HistoryRange; label: string; ms: number }[] = [
  { value: '1h', label: '1 h', ms: 3_600_000 },
  { value: '6h', label: '6 h', ms: 6 * 3_600_000 },
  { value: '24h', label: '24 h', ms: 86_400_000 },
  { value: '7d', label: '7 d', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 d', ms: 30 * 86_400_000 },
];

type MetricKey = 'cpu' | 'ram' | 'disk';
const METRICS: { key: MetricKey; label: string; threshold: number }[] = [
  { key: 'cpu', label: 'CPU', threshold: THRESHOLDS.cpu },
  { key: 'ram', label: 'RAM', threshold: THRESHOLDS.ram },
  { key: 'disk', label: 'Disco', threshold: THRESHOLDS.disk },
];

/** Inserta huecos donde faltan datos (servidor apagado) para que la línea se corte en lugar de unir puntos lejanos. */
function withGaps(points: MetricPoint[], bucketMs: number): MetricPoint[] {
  const result: MetricPoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous && point.t - previous.t > bucketMs * 2.5) {
      result.push({ t: previous.t + bucketMs, cpu: null, ram: null, disk: null, cpuMax: null });
    }
    result.push(point);
  }
  return result;
}

export function MetricsPanel({ serverId, stats, now }: { serverId: string; stats: ServerStats | null; now: number }) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const [showTable, setShowTable] = useState(false);
  const history = usePolling(() => api.history(serverId, range), 60_000, [serverId, range]);
  const span = RANGES.find((r) => r.value === range)!.ms;

  const points = useMemo(
    () => (history.data ? withGaps(history.data.points, history.data.bucketMs) : []),
    [history.data],
  );
  const stale = history.loading && history.data !== null && history.data.range !== range;
  const visibleMetrics = METRICS.filter((m) => m.key !== 'disk' || points.some((p) => p.disk !== null) || stats?.disk !== null);

  return (
    <div className="space-y-5">
      {/* Valores actuales */}
      <div className="grid grid-cols-3 gap-3">
        {METRICS.map((metric) => {
          const value = stats ? stats[metric.key] : null;
          return (
            <div key={metric.key} className="rounded-xl border border-line bg-bg/60 p-3">
              <div className="label-caps">{metric.label}</div>
              <div className={cn('mt-1 text-xl font-semibold', value !== null && value > metric.threshold ? 'text-warn' : 'text-ink')}>
                {stats?.online ? formatPercent(value) : '—'}
              </div>
              <div className="mt-2">
                <Meter value={stats?.online ? value : null} threshold={metric.threshold} label={`${metric.label} actual`} />
              </div>
            </div>
          );
        })}
      </div>
      {stats && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-ink-3">Encendido desde hace</dt>
          <dd className="text-right text-ink-2 sm:text-left">{formatDuration(stats.uptimeSeconds)}</dd>
          <dt className="text-ink-3">Último dato</dt>
          <dd className={cn('text-right sm:text-left', stats.online ? 'text-ink-2' : 'text-bad')}>{timeAgo(stats.lastUpdated, now)}</dd>
        </dl>
      )}

      {/* Filtro de rango, por encima de todas las gráficas */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <Segmented label="Periodo" value={range} onChange={setRange} options={RANGES.map(({ value, label }) => ({ value, label }))} />
        <Segmented
          label="Formato"
          value={showTable ? 'table' : 'chart'}
          onChange={(v) => setShowTable(v === 'table')}
          options={[
            { value: 'chart', label: <TrendingUp size={14} aria-label="Gráfica" />, title: 'Gráficas' },
            { value: 'table', label: <Table2 size={14} aria-label="Tabla" />, title: 'Tabla' },
          ]}
        />
      </div>

      {history.data === null && history.loading ? (
        <Spinner label="Cargando historial" />
      ) : history.error && history.data === null ? (
        <p className="text-sm text-bad">{history.error}</p>
      ) : points.length === 0 ? (
        <EmptyState icon={<TrendingUp size={24} aria-hidden />} title="Todavía no hay historial en este periodo">
          El panel guarda un punto por minuto desde que el servidor empieza a enviar datos con esta versión.
        </EmptyState>
      ) : showTable ? (
        <MetricsTable points={points} metrics={visibleMetrics} withDate={span > 86_400_000} />
      ) : (
        <div className={cn('space-y-4 transition-opacity', stale && 'opacity-50')}>
          {visibleMetrics.map((metric) => (
            <MetricChart key={metric.key} metric={metric} points={points} span={span} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function MetricChart({
  metric,
  points,
  span,
  now,
}: {
  metric: (typeof METRICS)[number];
  points: MetricPoint[];
  span: number;
  now: number;
}) {
  const withDate = span > 86_400_000;
  const values = points.map((p) => p[metric.key]).filter((v): v is number => v !== null);
  const peak = values.length ? Math.max(...values) : null;
  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  return (
    <figure>
      <figcaption className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{metric.label}</span>
        <span className="text-xs text-ink-3">
          media {formatPercent(average)} · máx. {formatPercent(peak)}
        </span>
      </figcaption>
      <div className="h-[132px]">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 140 }}>
          <AreaChart data={points} syncId="server-metrics" margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid vertical={false} stroke={GRID_COLOR} strokeDasharray="" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[now - span, now]}
              tickFormatter={(t: number) => formatTime(t, withDate)}
              tick={{ fill: AXIS_COLOR, fontSize: 10, style: { fontVariantNumeric: 'tabular-nums' } }}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
              minTickGap={40}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fill: AXIS_COLOR, fontSize: 10, style: { fontVariantNumeric: 'tabular-nums' } }}
              tickLine={false}
              axisLine={false}
            />
            <ReferenceLine
              y={metric.threshold}
              stroke="var(--color-warn)"
              strokeOpacity={0.55}
              strokeDasharray="3 4"
              ifOverflow="extendDomain"
            />
            <Tooltip
              cursor={{ stroke: 'rgb(255 255 255 / 0.25)', strokeWidth: 1 }}
              isAnimationActive={false}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const value = payload[0]?.value as number | null;
                return (
                  <div className="rounded-lg border border-line bg-surface-3 px-3 py-2 shadow-xl shadow-black/50">
                    <div className="flex items-center gap-2">
                      <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: SERIES_COLOR }} aria-hidden />
                      <span className="text-sm font-semibold text-ink">{formatPercent(value)}</span>
                      <span className="text-xs text-ink-2">{metric.label}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-3">{formatTime(Number(label), true)}</div>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey={metric.key}
              name={metric.label}
              stroke={SERIES_COLOR}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={SERIES_COLOR}
              fillOpacity={0.1}
              connectNulls={false}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, fill: SERIES_COLOR, stroke: 'var(--color-surface-2)', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function MetricsTable({
  points,
  metrics,
  withDate,
}: {
  points: MetricPoint[];
  metrics: typeof METRICS;
  withDate: boolean;
}) {
  const rows = points.filter((p) => metrics.some((m) => p[m.key] !== null)).slice(-60).reverse();
  return (
    <div className="scrollbar-thin max-h-[420px] overflow-auto rounded-xl border border-line">
      <table className="w-full text-[13px]">
        <caption className="sr-only">Historial de uso</caption>
        <thead className="sticky top-0 bg-surface-3 text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium text-ink-2">
              Hora
            </th>
            {metrics.map((m) => (
              <th key={m.key} scope="col" className="px-3 py-2 text-right font-medium text-ink-2">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((point) => (
            <tr key={point.t} className="border-t border-line">
              <td className="px-3 py-1.5 text-ink-3">{formatTime(point.t, withDate)}</td>
              {metrics.map((m) => (
                <td key={m.key} className="px-3 py-1.5 text-right text-ink">
                  {formatPercent(point[m.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
