import { AppWindow, Globe, LockKeyhole, Package, Play, RefreshCw, Server, Waypoints } from 'lucide-react';
import type { Diagnosis, RouteStep, RouteStepId } from '../../../shared/types';
import { timeAgo } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui';

const STEP_KIND: Record<RouteStepId, { icon: typeof Globe; kind: string }> = {
  dns: { icon: Globe, kind: 'Dominio' },
  server: { icon: Server, kind: 'Servidor' },
  tls: { icon: LockKeyhole, kind: 'HTTPS' },
  proxy: { icon: Waypoints, kind: 'Proxy' },
  container: { icon: Package, kind: 'Contenedor' },
  app: { icon: AppWindow, kind: 'Aplicación' },
};

const DOT: Record<RouteStep['status'], string> = {
  ok: 'border-ok/50 bg-ok/10 text-ok',
  fail: 'border-bad bg-bad/15 text-bad',
  warn: 'border-warn/60 bg-warn/10 text-warn',
  skip: 'border-line bg-surface-2 text-ink-3',
};

/**
 * La ruta que sigue una visita hasta la web, de arriba abajo, con el punto donde se rompe.
 * Lo que hay después del fallo sale apagado: no se ha llegado hasta ahí.
 */
export function RouteView({
  diagnosis,
  busy,
  onRetry,
  onAction,
  actionBusy,
  now,
}: {
  diagnosis: Diagnosis;
  busy: boolean;
  onRetry: () => void;
  onAction?: () => void;
  actionBusy?: boolean;
  now: number;
}) {
  const failIndex = diagnosis.steps.findIndex((s) => s.status === 'fail');
  return (
    <div className="space-y-3">
      <div className={cn('rounded-[10px] border px-3 py-2.5', diagnosis.ok ? 'border-ok/25 bg-ok/[0.06]' : 'border-bad/30 bg-bad/[0.07]')}>
        <p className={cn('text-[13px] font-semibold', diagnosis.ok ? 'text-ok' : 'text-bad')}>{diagnosis.title}</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{diagnosis.summary}</p>
        {diagnosis.action && onAction && (
          <Button variant="primary" size="sm" className="mt-2.5" loading={actionBusy} icon={<Play size={13} aria-hidden />} onClick={onAction}>
            Arrancar {diagnosis.action.container} en {diagnosis.action.serverName}
          </Button>
        )}
      </div>

      <ol className="relative">
        {diagnosis.steps.map((step, i) => {
          const { icon: Icon, kind } = STEP_KIND[step.id];
          const after = failIndex !== -1 && i > failIndex;
          const last = i === diagnosis.steps.length - 1;
          return (
            <li key={step.id} className={cn('relative flex gap-3 pb-3', last && 'pb-0', after && 'opacity-45')}>
              {!last && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-7 bottom-0 left-[13px] w-px',
                    failIndex !== -1 && i >= failIndex ? 'border-l border-dashed border-line-strong' : step.status === 'ok' || step.status === 'warn' ? 'bg-ok/40' : 'bg-line',
                  )}
                />
              )}
              <span className={cn('relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border', DOT[step.status])}>
                <Icon size={14} aria-hidden />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium break-all text-ink">{step.label}</span>
                  <span className="text-[10.5px] tracking-wide text-ink-3 uppercase">{kind}</span>
                  {step.status === 'fail' && <span className="rounded bg-bad/15 px-1.5 py-px text-[10.5px] font-semibold text-bad">Se cae aquí</span>}
                  {step.status === 'warn' && <span className="rounded bg-warn/15 px-1.5 py-px text-[10.5px] font-semibold text-warn">Ojo</span>}
                </div>
                <p className={cn('mt-0.5 text-[12px] leading-snug break-words', step.status === 'fail' ? 'text-ink-2' : 'text-ink-3')}>{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex items-center justify-between gap-2 text-[11.5px] text-ink-3">
        <span>Comprobado {timeAgo(diagnosis.at, now)}</span>
        <button type="button" onClick={onRetry} disabled={busy} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink disabled:opacity-50">
          <RefreshCw size={12} className={cn(busy && 'animate-spin')} aria-hidden /> {busy ? 'Siguiendo la ruta…' : 'Volver a comprobar'}
        </button>
      </div>
    </div>
  );
}
