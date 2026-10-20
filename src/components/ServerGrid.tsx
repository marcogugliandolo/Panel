import { Boxes, ChevronRight, Clock, ServerOff } from 'lucide-react';
import { THRESHOLDS } from '../../shared/types';
import { formatDuration, formatPercent, timeAgo } from '../lib/format';
import { nodeIcon } from '../lib/icons';
import { HEALTH_META, TONE_COLOR, type ServerView } from '../lib/status';
import { cn } from '../lib/utils';
import { EmptyState, Meter, StatusBadge } from './ui';

const ORDER = { offline: 0, warning: 1, online: 2, nodata: 3 } as const;

export function ServerGrid({ servers, onSelect, now }: { servers: ServerView[]; onSelect: (key: string) => void; now: number }) {
  if (servers.length === 0) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <EmptyState icon={<ServerOff size={28} aria-hidden />} title="Aún no hay servidores">
          Añade nodos al esquema o instala el script de métricas en tus servidores: aparecerán aquí en cuanto envíen datos.
        </EmptyState>
      </div>
    );
  }

  const sorted = [...servers].sort((a, b) => ORDER[a.health] - ORDER[b.health] || a.title.localeCompare(b.title));

  return (
    <div className="mx-auto grid max-w-7xl gap-3 p-4 sm:grid-cols-2 md:p-6 xl:grid-cols-3">
      {sorted.map((server) => {
        const meta = HEALTH_META[server.health];
        const stats = server.stats;
        const Icon = nodeIcon(server.node?.icon);
        const metrics = [
          { label: 'CPU', value: stats?.cpu ?? null, threshold: THRESHOLDS.cpu },
          { label: 'RAM', value: stats?.ram ?? null, threshold: THRESHOLDS.ram },
          { label: 'Disco', value: stats?.disk ?? null, threshold: THRESHOLDS.disk },
        ];
        return (
          <button
            key={server.key}
            type="button"
            onClick={() => onSelect(server.key)}
            className="group flex flex-col rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
          >
            <div className="flex w-full items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.03]">
                  <Icon size={17} style={{ color: TONE_COLOR[meta.tone] }} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{server.title}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-3">
                    {server.serverId}
                    {stats?.hostname && stats.hostname !== server.serverId ? ` · ${stats.hostname}` : ''}
                  </span>
                </span>
              </div>
              <StatusBadge tone={meta.tone} label={meta.label} />
            </div>

            {server.subtitle && !server.node && <p className="mt-2 text-xs text-warn/90">{server.subtitle}</p>}

            <div className="mt-4 grid w-full grid-cols-3 gap-3">
              {metrics.map((metric) => (
                <div key={metric.label} className="space-y-1.5">
                  <div className="label-caps">{metric.label}</div>
                  <div className={cn('text-[15px] font-semibold', metric.value !== null && metric.value > metric.threshold ? 'text-warn' : 'text-ink')}>
                    {formatPercent(metric.value)}
                  </div>
                  <Meter value={stats?.online ? metric.value : null} threshold={metric.threshold} label={`${metric.label} de ${server.title}`} />
                </div>
              ))}
            </div>

            <div className="mt-4 flex w-full items-center gap-4 border-t border-line pt-3 text-xs text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <Boxes size={13} aria-hidden />
                {stats?.appsTotal !== null && stats?.appsTotal !== undefined ? `${stats.appsRunning ?? '—'}/${stats.appsTotal} contenedores` : 'Sin contenedores'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock size={13} aria-hidden />
                {stats ? (stats.online && stats.uptimeSeconds !== null ? `Encendido ${formatDuration(stats.uptimeSeconds)}` : timeAgo(stats.lastUpdated, now)) : 'Sin datos'}
              </span>
              <ChevronRight size={15} className="ml-auto text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </div>

            {server.problems.length > 0 && (
              <ul className="mt-3 w-full space-y-1">
                {server.problems.map((problem) => (
                  <li key={problem.id} className={cn('text-xs', server.health === 'offline' ? 'text-bad' : 'text-warn')}>
                    <span className="font-medium">{problem.title}:</span> {problem.detail}
                  </li>
                ))}
              </ul>
            )}
          </button>
        );
      })}
    </div>
  );
}
