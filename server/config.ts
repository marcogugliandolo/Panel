import path from 'node:path';

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  port: positiveNumber('PORT', 3000),
  isProduction: process.env.NODE_ENV === 'production',
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),

  // Acceso al panel. Sin PANEL_PASSWORD se genera una contraseña temporal en cada arranque.
  username: process.env.PANEL_USERNAME || 'admin',
  password: process.env.PANEL_PASSWORD || '',
  sessionDays: positiveNumber('SESSION_DAYS', 30),

  // Token que deben enviar los scripts de métricas. Vacío = se aceptan envíos sin token.
  statsToken: process.env.STATS_TOKEN || '',

  // Un servidor se considera caído si lleva este tiempo sin enviar métricas.
  // Los scripts se ejecutan cada minuto por cron: 5 minutos sin datos = 5 envíos perdidos.
  offlineAfterMs: positiveNumber('OFFLINE_AFTER_MINUTES', 5) * 60_000,
  // Días de historial (métricas y comprobaciones de webs) que se conservan.
  historyDays: positiveNumber('HISTORY_DAYS', 30),

  portainerUrl: (process.env.PORTAINER_URL || '').replace(/\/+$/, ''),
  portainerToken: process.env.PORTAINER_TOKEN || '',

  // Proxies de confianza para X-Forwarded-For / X-Forwarded-Proto (Nginx Proxy Manager, Traefik…).
  trustProxy: process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
};
