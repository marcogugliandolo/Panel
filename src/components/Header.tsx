import { Activity, AlertTriangle, Bell, Briefcase, Building2, Edit2, Info, LogOut, Network, Save, Settings2, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import type { PanelAlert } from '../lib/status';

export type View = 'clasica' | 'oficina' | 'edificio';

const SUBTITLES: Record<View, string> = {
  clasica: 'Vista esquemática servidores',
  oficina: 'Vista oficina',
  edificio: 'Vista edificio',
};

const VIEWS: { value: View; label: string; icon: typeof Network }[] = [
  { value: 'clasica', label: 'Clásica', icon: Network },
  { value: 'oficina', label: 'Oficina', icon: Briefcase },
  { value: 'edificio', label: 'Edificio', icon: Building2 },
];

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
  isEditing: boolean;
  onToggleEdit: () => void;
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
  isEditing,
  onToggleEdit,
}: HeaderProps) {
  const errors = alerts.filter((a) => a.severity === 'error').length;
  const state = connectionError
    ? { label: 'Sin conexión', color: 'text-bad' }
    : errors > 0
      ? { label: 'Incidencias', color: 'text-bad' }
      : alerts.length > 0
        ? { label: 'Avisos', color: 'text-warn' }
        : { label: 'Correcto', color: 'text-ok' };

  const switcher = (
    <div role="group" aria-label="Vista" className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
      {VIEWS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          disabled={isEditing && value !== view}
          onClick={() => onViewChange(value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            view === value ? 'bg-white/10 text-white' : 'text-[#8e9299] hover:text-white',
          )}
        >
          <Icon size={14} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <header className="sticky top-0 z-40 flex min-h-[5rem] flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-white/10 bg-[#0a0a0c]/80 px-4 py-3 backdrop-blur-xl md:px-8 [@media(max-height:500px)]:min-h-0 [@media(max-height:500px)]:py-2">
      <div className="flex min-w-0 items-center gap-3 md:gap-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#00ff9d] to-[#00cc7d] text-black shadow-[0_0_20px_rgba(0,255,157,0.4)] md:size-10">
          <Activity className="size-5 md:size-6" strokeWidth={2.5} aria-hidden />
        </div>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-white md:gap-3 md:text-xl">
            Server Panel
            {isEditing ? (
              <span className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 font-mono text-[9px] tracking-widest text-blue-400 md:text-[10px]">
                <Settings2 size={10} aria-hidden />
                <span className="hidden sm:inline">MODO EDICIÓN</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full border border-[#00ff9d]/20 bg-[#00ff9d]/10 px-2 py-0.5 font-mono text-[9px] tracking-widest text-[#00ff9d] md:text-[10px]">
                <span className="size-1.5 animate-pulse rounded-full bg-[#00ff9d]" />
                <span className="hidden sm:inline">EN VIVO</span>
              </span>
            )}
          </h1>
          <p className="mt-0.5 hidden font-mono text-xs tracking-wider text-[#8e9299] uppercase md:block [@media(max-height:500px)]:hidden">{SUBTITLES[view]}</p>
        </div>
        <div className="ml-2 hidden lg:block [@media(max-height:500px)]:block">{switcher}</div>
      </div>

      <div className="flex items-center gap-2 md:gap-4">
        {!isEditing && (
          <AlertsMenu
            alerts={alerts}
            dismissedCount={dismissedCount}
            onDismiss={onDismiss}
            onRestoreDismissed={onRestoreDismissed}
            onOpenAlert={onOpenAlert}
          />
        )}

        {view === 'clasica' && (
          <button
            type="button"
            onClick={onToggleEdit}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold transition-all md:px-4',
              isEditing
                ? 'border-blue-500/50 bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                : 'border-white/10 bg-white/5 text-white hover:bg-white/10',
            )}
            title={isEditing ? 'Terminar Edición' : 'Editar Diseño'}
          >
            {isEditing ? <Save size={16} aria-hidden /> : <Edit2 size={16} aria-hidden />}
            <span className="hidden md:inline [@media(max-height:500px)]:hidden">{isEditing ? 'Terminar Edición' : 'Editar Diseño'}</span>
          </button>
        )}

        {!isEditing && (
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 md:px-4" role="status" aria-live="polite">
            <ShieldCheck size={16} className={state.color} aria-hidden />
            <span aria-hidden className="hidden font-mono text-xs tracking-widest text-[#8e9299] uppercase md:inline [@media(max-height:500px)]:hidden">
              Estado: <span className={cn('font-bold', state.color)}>{state.label}</span>
            </span>
            <span className="sr-only">Estado: {state.label}</span>
          </div>
        )}

        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm font-bold text-red-400 transition-all hover:bg-red-500/20 md:ml-2"
          title={username ? `Cerrar sesión (${username})` : 'Cerrar sesión'}
          aria-label="Cerrar sesión"
        >
          <LogOut size={16} aria-hidden />
        </button>
      </div>

      <div className="flex w-full justify-center lg:hidden [@media(max-height:500px)]:hidden">{switcher}</div>
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={alerts.length ? `Avisos (${alerts.length})` : 'Avisos'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative rounded-lg border p-2 transition-all',
          open ? 'border-white/20 bg-white/10 text-white' : 'border-white/10 bg-white/5 text-[#8e9299] hover:text-white',
        )}
      >
        <Bell size={20} aria-hidden />
        {alerts.length > 0 && (
          <span className="absolute -top-1 -right-1 flex size-4 animate-bounce items-center justify-center rounded-full border-2 border-[#0a0a0c] bg-red-500 text-[10px] font-bold text-white">
            {alerts.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 z-[60] mt-3 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-white/10 bg-[#151619] shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/5 bg-white/5 p-4">
            <h3 className="flex items-center gap-2 text-sm font-bold text-white">
              <Bell size={14} className="text-blue-400" aria-hidden />
              Notificaciones
            </h3>
            <span className="font-mono text-[10px] tracking-widest text-[#8e9299] uppercase">{alerts.length} activas</span>
          </div>
          <ul className="scrollbar-thin max-h-[400px] overflow-y-auto">
            {alerts.length === 0 && (
              <li className="p-12 text-center">
                <ShieldCheck size={32} className="mx-auto mb-3 text-[#00ff9d] opacity-20" aria-hidden />
                <p className="font-mono text-sm tracking-widest text-[#8e9299] uppercase">Todo correcto</p>
                <p className="mt-1 text-[10px] text-[#8e9299]/50">No hay alertas activas en este momento</p>
              </li>
            )}
            {alerts.map((alert) => (
              <li
                key={alert.id}
                className={cn(
                  'relative border-b border-l-2 border-white/5 last:border-b-0',
                  alert.severity === 'error' ? 'border-l-red-500' : 'border-l-yellow-500',
                )}
              >
                <button
                  type="button"
                  className="flex w-full gap-3 p-4 pr-10 text-left transition-colors hover:bg-white/5"
                  onClick={() => {
                    setOpen(false);
                    onOpenAlert(alert);
                  }}
                >
                  <span
                    className={cn(
                      'shrink-0 self-start rounded-lg p-2',
                      alert.severity === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-yellow-500/10 text-yellow-500',
                    )}
                  >
                    {alert.severity === 'error' ? <AlertTriangle size={16} aria-hidden /> : <Info size={16} aria-hidden />}
                  </span>
                  <span className="min-w-0">
                    <span className="mb-1 block text-xs font-bold text-white">{alert.title}</span>
                    <span className="block text-[11px] leading-relaxed break-words text-[#8e9299]">{alert.message}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Ocultar hasta mañana"
                  title="Ocultar por hoy"
                  className="absolute top-3 right-3 rounded p-1 text-[#8e9299] transition-colors hover:bg-white/10 hover:text-white"
                  onClick={() => onDismiss(alert)}
                >
                  <X size={10} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          {dismissedCount > 0 && (
            <button
              type="button"
              onClick={onRestoreDismissed}
              className="w-full border-t border-white/5 px-4 py-2.5 text-xs text-[#8e9299] transition-colors hover:bg-white/5 hover:text-white"
            >
              {dismissedCount === 1 ? '1 aviso oculto hoy' : `${dismissedCount} avisos ocultos hoy`} · Mostrar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
