import { Activity, AlertTriangle, Bell, Globe2, LayoutGrid, LogOut, Network, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import type { PanelAlert } from '../lib/status';
import { IconButton, Segmented, StatusDot } from './ui';

export type View = 'map' | 'servers' | 'webs';

interface HeaderProps {
  view: View;
  onViewChange: (view: View) => void;
  alerts: PanelAlert[];
  dismissedCount: number;
  onDismiss: (alert: PanelAlert) => void;
  onRestoreDismissed: () => void;
  onOpenAlert: (alert: PanelAlert) => void;
  onLogout: () => void;
  username?: string;
  connectionError: string | null;
}

export function Header({
  view,
  onViewChange,
  alerts,
  dismissedCount,
  onDismiss,
  onRestoreDismissed,
  onOpenAlert,
  onLogout,
  username,
  connectionError,
}: HeaderProps) {
  const errors = alerts.filter((a) => a.severity === 'error').length;
  const summary = connectionError
    ? { tone: 'bad' as const, label: 'Sin conexión' }
    : errors > 0
      ? { tone: 'bad' as const, label: errors === 1 ? '1 incidencia' : `${errors} incidencias` }
      : alerts.length > 0
        ? { tone: 'warn' as const, label: alerts.length === 1 ? '1 aviso' : `${alerts.length} avisos` }
        : { tone: 'ok' as const, label: 'Todo correcto' };

  const tabs = (
    <Segmented<View>
      label="Vista"
      value={view}
      onChange={onViewChange}
      options={[
        { value: 'map', label: <><Network size={14} aria-hidden /> Esquema</> },
        { value: 'servers', label: <><LayoutGrid size={14} aria-hidden /> Servidores</> },
        { value: 'webs', label: <><Globe2 size={14} aria-hidden /> Webs</> },
      ]}
    />
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-3 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-black shadow-[0_0_18px_rgb(0_255_157/0.3)]">
            <Activity size={18} strokeWidth={2.5} aria-hidden />
          </div>
          <span className="truncate text-[15px] font-semibold tracking-tight">Server Panel</span>
        </div>

        <div className="ml-4 hidden md:block">{tabs}</div>

        <div className="ml-auto flex items-center gap-1.5">
          <div
            className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium sm:flex"
            role="status"
            aria-live="polite"
          >
            <StatusDot tone={summary.tone} pulse={summary.tone !== 'ok'} />
            <span className={cn(summary.tone === 'ok' ? 'text-ink-2' : summary.tone === 'warn' ? 'text-warn' : 'text-bad')}>
              {summary.label}
            </span>
          </div>

          <AlertsMenu
            alerts={alerts}
            dismissedCount={dismissedCount}
            onDismiss={onDismiss}
            onRestoreDismissed={onRestoreDismissed}
            onOpenAlert={onOpenAlert}
          />

          <IconButton label={username ? `Cerrar sesión (${username})` : 'Cerrar sesión'} onClick={onLogout}>
            <LogOut size={17} />
          </IconButton>
        </div>
      </div>
      <div className="flex justify-center border-t border-line px-4 py-2 md:hidden">{tabs}</div>
    </header>
  );
}

function AlertsMenu({
  alerts,
  dismissedCount,
  onDismiss,
  onRestoreDismissed,
  onOpenAlert,
}: Pick<HeaderProps, 'alerts' | 'dismissedCount' | 'onDismiss' | 'onRestoreDismissed' | 'onOpenAlert'>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasErrors = alerts.some((a) => a.severity === 'error');

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        label={alerts.length ? `Avisos (${alerts.length})` : 'Avisos'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(open && 'bg-white/[0.06] text-ink')}
      >
        <Bell size={17} />
        {alerts.length > 0 && (
          <span
            className={cn(
              'absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-bold',
              hasErrors ? 'bg-bad text-white' : 'bg-warn text-black',
            )}
          >
            {alerts.length}
          </span>
        )}
      </IconButton>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface-2 shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Avisos</h2>
            <span className="label-caps">{alerts.length} activos</span>
          </div>
          <ul className="scrollbar-thin max-h-[60vh] overflow-y-auto">
            {alerts.length === 0 && (
              <li className="flex flex-col items-center px-6 py-10 text-center">
                <ShieldCheck size={28} className="mb-2 text-ok opacity-60" aria-hidden />
                <p className="text-sm text-ink-2">Todo correcto</p>
                <p className="mt-0.5 text-xs text-ink-3">No hay avisos en este momento.</p>
              </li>
            )}
            {alerts.map((alert) => (
              <li key={alert.id} className="group relative border-b border-line last:border-0">
                <button
                  type="button"
                  className="flex w-full gap-3 px-4 py-3 pr-11 text-left transition-colors hover:bg-white/[0.04]"
                  onClick={() => {
                    setOpen(false);
                    onOpenAlert(alert);
                  }}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
                      alert.severity === 'error' ? 'bg-bad/12 text-bad' : 'bg-warn/12 text-warn',
                    )}
                  >
                    <AlertTriangle size={14} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{alert.title}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed break-words text-ink-3">{alert.message}</span>
                  </span>
                </button>
                <IconButton
                  label="Ocultar hasta mañana"
                  className="absolute top-2.5 right-2 size-7"
                  onClick={() => onDismiss(alert)}
                >
                  <X size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
          {dismissedCount > 0 && (
            <button
              type="button"
              onClick={onRestoreDismissed}
              className="w-full border-t border-line px-4 py-2.5 text-xs text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink-2"
            >
              {dismissedCount === 1 ? '1 aviso oculto hoy' : `${dismissedCount} avisos ocultos hoy`} · Mostrar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
