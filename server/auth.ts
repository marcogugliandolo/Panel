import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config';
import type { DB } from './db';

const COOKIE_NAME = 'panel_session';
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();
const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export function createAuth(db: DB) {
  let password = config.password;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    console.warn(
      [
        '',
        '[auth] PANEL_PASSWORD no está configurada.',
        `[auth] Contraseña temporal para el usuario "${config.username}": ${password}`,
        '[auth] Cambia en cada arranque. Define PANEL_USERNAME y PANEL_PASSWORD en el stack para fijar las tuyas.',
        '',
      ].join('\n'),
    );
  }

  const expectedUser = sha256(config.username);
  const expectedPassword = sha256(password);

  function credentialsMatch(username: string, candidate: string): boolean {
    // Se comparan los dos campos siempre, para que el tiempo de respuesta no revele cuál falló.
    const userOk = crypto.timingSafeEqual(sha256(username), expectedUser);
    const passwordOk = crypto.timingSafeEqual(sha256(candidate), expectedPassword);
    return userOk && passwordOk;
  }

  // Límite de intentos fallidos por IP, en memoria.
  const failures = new Map<string, { count: number; first: number }>();
  function isBlocked(ip: string): boolean {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
      failures.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }
  function recordFailure(ip: string) {
    const entry = failures.get(ip);
    if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
      failures.set(ip, { count: 1, first: Date.now() });
    } else {
      entry.count += 1;
    }
  }

  function getSession(req: Request): { username: string } | null {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const row = db
      .prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?')
      .get(sha256Hex(token)) as { username: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return { username: row.username };
  }

  /** Exige sesión. Las peticiones que modifican algo además deben llevar la cabecera X-Panel-Request (anti-CSRF). */
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: 'Sesión no iniciada o caducada' });
      return;
    }
    const isSafeMethod = req.method === 'GET' || req.method === 'HEAD';
    if (!isSafeMethod && req.get('X-Panel-Request') !== '1') {
      res.status(403).json({ error: 'Petición rechazada' });
      return;
    }
    res.locals.username = session.username;
    next();
  }

  const router = express.Router();

  router.post('/login', (req, res) => {
    const ip = req.ip || 'desconocida';
    if (isBlocked(ip)) {
      res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      return;
    }
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!credentialsMatch(username, candidate)) {
      recordFailure(ip);
      console.warn(`[auth] Intento de acceso fallido desde ${ip}`);
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      return;
    }
    failures.delete(ip);

    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const maxAge = config.sessionDays * 86_400_000;
    db.prepare('INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256Hex(token),
      config.username,
      now,
      now + maxAge,
    );
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge,
      path: '/',
    });
    res.json({ authenticated: true, username: config.username });
  });

  router.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ authenticated: false });
  });

  router.get('/me', (req, res) => {
    const session = getSession(req);
    res.json(session ? { authenticated: true, username: session.username } : { authenticated: false });
  });

  return { router, requireAuth };
}

/** Comprueba el token de los scripts de métricas, si STATS_TOKEN está definido. */
export function requireStatsToken(req: Request, res: Response, next: NextFunction) {
  if (!config.statsToken) {
    next();
    return;
  }
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || req.get('x-panel-token') || (typeof req.query.token === 'string' ? req.query.token : '');
  if (provided && crypto.timingSafeEqual(sha256(provided), sha256(config.statsToken))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Token de métricas no válido' });
}
