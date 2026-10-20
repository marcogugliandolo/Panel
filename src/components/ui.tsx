import { Loader2, X } from 'lucide-react';
import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { TONE_COLOR, type Tone } from '../lib/status';

// --- Botones ---

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-black hover:bg-accent/85 font-semibold',
  secondary: 'bg-surface-3 text-ink border border-line hover:border-line-strong hover:bg-white/[0.07]',
  ghost: 'text-ink-2 hover:text-ink hover:bg-white/[0.06]',
  danger: 'bg-bad/10 text-bad border border-bad/25 hover:bg-bad/20',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5',
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors',
        'hover:bg-white/[0.06] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

// --- Estado ---

export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  const color = TONE_COLOR[tone];
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ backgroundColor: color }} />}
      <span className="relative inline-flex size-2 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
    </span>
  );
}

/** Estado con punto de color y texto: el color nunca va solo. */
export function StatusBadge({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        className,
      )}
      style={{
        color: tone === 'idle' ? 'var(--color-ink-2)' : TONE_COLOR[tone],
        borderColor: `color-mix(in srgb, ${TONE_COLOR[tone]} 30%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${TONE_COLOR[tone]} 8%, transparent)`,
      }}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

/** Barra de uso: el relleno indica la severidad, la pista es un tono más claro del mismo color. */
export function Meter({ value, threshold, label }: { value: number | null; threshold: number; label: string }) {
  const tone: Tone = value === null ? 'idle' : value > threshold ? (value > Math.min(98, threshold + 10) ? 'bad' : 'warn') : 'ok';
  const color = TONE_COLOR[tone];
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${value ?? 0}%`, backgroundColor: color }}
      />
    </div>
  );
}

// --- Formularios ---

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  'h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink placeholder:text-ink-3 ' +
  'transition-colors hover:border-line-strong focus:border-accent/60 focus:outline-none focus-visible:outline-none ' +
  'focus:ring-2 focus:ring-accent/20';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-line bg-bg p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
            option.value === value ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// --- Diálogos ---

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'center',
  wide = false,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  variant?: 'center' | 'sheet';
  /** Diálogo centrado más ancho (logs, tablas). */
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // React propaga "cancel" a los diálogos que contienen a este: solo se cierra el de arriba.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        'max-h-none max-w-none bg-transparent p-0 text-ink backdrop:bg-black/65 backdrop:backdrop-blur-[2px]',
        variant === 'center'
          ? cn('m-auto w-[calc(100%-2rem)]', wide ? 'max-w-4xl' : 'max-w-lg')
          : 'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-[640px]',
      )}
    >
      <div
        className={cn(
          'flex flex-col border border-line bg-surface-2 shadow-2xl shadow-black/60',
          variant === 'center' ? 'max-h-[calc(100dvh-2rem)] rounded-2xl' : 'h-full border-y-0 border-r-0',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description && <div className="mt-0.5 text-[13px] text-ink-3">{description}</div>}
          </div>
          <IconButton label="Cerrar" onClick={onClose} className="-mr-2 -mt-1">
            <X size={18} />
          </IconButton>
        </header>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    [],
  );
  const close = (value: boolean) => {
    state?.resolve(value);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state !== null}
        onClose={() => close(false)}
        title={state?.title}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancelar
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed text-ink-2">{state?.message}</div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);

// --- Avisos flotantes ---

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'bad';
}

const ToastContext = createContext<(message: string, tone?: 'ok' | 'bad') => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const notify = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = ++counter.current;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[200] flex flex-col items-center gap-2 sm:left-auto sm:right-6 sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'bad' ? 'alert' : 'status'}
            className="pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-xl border border-line bg-surface-3 px-4 py-3 text-sm text-ink shadow-xl shadow-black/50"
          >
            <StatusDot tone={toast.tone} />
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// --- Varios ---

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <div className="mb-3 text-ink-3">{icon}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Cargando' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden />
      {label}…
    </div>
  );
}
