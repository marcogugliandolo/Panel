const decimal = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const integer = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatter = digits === 0 ? integer : decimal;
  return `${formatter.format(value)} %`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value >= 1000 ? `${decimal.format(value / 1000)} s` : `${integer.format(value)} ms`;
}

export function formatNumber(value: number): string {
  return integer.format(value);
}

/** "hace 3 min", "hace 2 h", "hace 4 d" */
export function timeAgo(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return 'nunca';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'ahora mismo';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

/** Duración compacta: "12 d 4 h", "3 h 20 min", "45 min" */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return '—';
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(timestamp: number, withDate = false): string {
  return new Date(timestamp).toLocaleString('es-ES', {
    ...(withDate ? { day: 'numeric', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function daysUntil(timestamp: number, now = Date.now()): number {
  return Math.floor((timestamp - now) / 86_400_000);
}

/** Quita los códigos de color ANSI de los logs. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
