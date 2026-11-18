import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { config } from './config';
import type { DB } from './db';
import { createTwoFactorStore, matchTotp, base32Decode, newSecret, otpauthUri } from './twofactor';

const COOKIE_NAME = 'panel_session';
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;
/** Tiempo para escribir el código del doble factor después de acertar la contraseña. */
const TICKET_MS = 5 * 60_000;
const TICKET_MAX_TRIES = 5;
/** Tiempo para escanear el QR y confirmar el primer código al activar el doble factor. */
const SETUP_MS = 10 * 60_000;

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

  const twoFactor = createTwoFactorStore(db);
  if (config.twoFactorReset && twoFactor.isEnabled()) {
    twoFactor.disable();
    console.warn(
      [
        '',
        '[auth] PANEL_2FA_RESET está activa: se ha DESACTIVADO el doble factor.',
        '[auth] Entra con usuario y contraseña, vuelve a activarlo desde Seguridad y QUITA la variable del stack.',
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

  function getSession(req: Request): { username: string; tokenHash: string } | null {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const row = db
      .prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as { username: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return { username: row.username, tokenHash };
  }

  function startSession(req: Request, res: Response) {
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
  }

  // Contraseña correcta, falta el código: el navegador recibe un ticket de un solo uso para el segundo paso.
  const tickets = new Map<string, { expires: number; tries: number }>();
  // Activación en curso: secreto aún sin confirmar, ligado a la sesión que lo pidió.
  const pendingSetups = new Map<string, { secret: string; expires: number }>();
  function sweep() {
    const now = Date.now();
    for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
    for (const [k, p] of pendingSetups) if (p.expires < now) pendingSetups.delete(k);
  }

  const readString = (value: unknown) => (typeof value === 'string' ? value : '');

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
    const username = readString(req.body?.username);
    const candidate = readString(req.body?.password);
    if (!credentialsMatch(username, candidate)) {
      recordFailure(ip);
      console.warn(`[auth] Intento de acceso fallido desde ${ip}`);
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      return;
    }

    if (twoFactor.isEnabled()) {
      sweep();
      const ticket = crypto.randomBytes(32).toString('base64url');
      tickets.set(sha256Hex(ticket), { expires: Date.now() + TICKET_MS, tries: 0 });
      res.json({ authenticated: false, twoFactor: true, ticket });
      return;
    }

    failures.delete(ip);
    startSession(req, res);
    res.json({ authenticated: true, username: config.username });
  });

  /** Segundo paso del acceso: código de la app o código de recuperación. */
  router.post('/login/code', (req, res) => {
    const ip = req.ip || 'desconocida';
    if (isBlocked(ip)) {
      res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      return;
    }
    sweep();
    const key = sha256Hex(readString(req.body?.ticket));
    const ticket = tickets.get(key);
    if (!ticket) {
      res.status(401).json({ error: 'Ha pasado demasiado tiempo. Vuelve a escribir la contraseña.', expired: true });
      return;
    }
    const result = twoFactor.verify(readString(req.body?.code));
    if (!result.ok) {
      recordFailure(ip);
      ticket.tries += 1;
      console.warn(`[auth] Código de doble factor incorrecto desde ${ip}`);
      if (ticket.tries >= TICKET_MAX_TRIES) {
        tickets.delete(key);
        res.status(401).json({ error: 'Demasiados códigos incorrectos. Vuelve a escribir la contraseña.', expired: true });
        return;
      }
      res.status(401).json({ error: 'Código incorrecto' });
      return;
    }
    tickets.delete(key);
    failures.delete(ip);
    if (result.usedRecovery) console.warn(`[auth] Acceso con código de recuperación desde ${ip} (quedan ${result.recoveryLeft})`);
    startSession(req, res);
    res.json({
      authenticated: true,
      username: config.username,
      ...(result.usedRecovery ? { recoveryLeft: result.recoveryLeft } : {}),
    });
  });

  /* --- Gestión del doble factor (con sesión iniciada) --- */
  router.get('/2fa', requireAuth, (_req, res) => {
    res.json(twoFactor.status());
  });

  router.post('/2fa/setup', requireAuth, async (req, res, next) => {
    try {
      if (twoFactor.isEnabled()) {
        res.status(409).json({ error: 'El doble factor ya está activado' });
        return;
      }
      sweep();
      const session = getSession(req)!;
      const secret = newSecret();
      pendingSetups.set(session.tokenHash, { secret, expires: Date.now() + SETUP_MS });
      const uri = otpauthUri(secret, config.username);
      const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
    } catch (error) {
      next(error);
    }
  });

  router.post('/2fa/enable', requireAuth, (req, res) => {
    sweep();
    const ip = req.ip || 'desconocida';
    const session = getSession(req)!;
    const pending = pendingSetups.get(session.tokenHash);
    if (!pending) {
      res.status(400).json({ error: 'La activación ha caducado. Vuelve a empezar.' });
      return;
    }
    const step = matchTotp(base32Decode(pending.secret), readString(req.body?.code));
    if (step === null) {
      recordFailure(ip);
      res.status(400).json({ error: 'El código no coincide. Comprueba que la hora del móvil es correcta.' });
      return;
    }
    pendingSetups.delete(session.tokenHash);
    const recoveryCodes = twoFactor.enable(pending.secret, step);
    // Las demás sesiones abiertas se cierran: a partir de ahora hace falta el código para entrar.
    const closed = db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(session.tokenHash).changes;
    console.warn(`[auth] Doble factor activado desde ${ip}; ${closed} sesión(es) cerrada(s)`);
    res.json({ recoveryCodes, closedSessions: closed });
  });

  router.post('/2fa/disable', requireAuth, (req, res) => {
    const ip = req.ip || 'desconocida';
    if (isBlocked(ip)) {
      res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      return;
    }
    const passwordOk = crypto.timingSafeEqual(sha256(readString(req.body?.password)), expectedPassword);
    const codeOk = passwordOk && twoFactor.verify(readString(req.body?.code)).ok;
    if (!passwordOk || !codeOk) {
      recordFailure(ip);
      res.status(400).json({ error: passwordOk ? 'Código incorrecto' : 'Contraseña incorrecta' });
      return;
    }
    twoFactor.disable();
    console.warn(`[auth] Doble factor desactivado desde ${ip}`);
    res.json(twoFactor.status());
  });

  router.post('/2fa/recovery', requireAuth, (req, res) => {
    const ip = req.ip || 'desconocida';
    if (isBlocked(ip)) {
      res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      return;
    }
    const code = readString(req.body?.code).replace(/\s/g, '');
    // Solo con un código de la app: con uno de recuperación se podrían encadenar sin tener el móvil.
    if (!/^\d{6}$/.test(code) || !twoFactor.verify(code).ok) {
      recordFailure(ip);
      res.status(400).json({ error: 'Código incorrecto' });
      return;
    }
    res.json({ recoveryCodes: twoFactor.regenerateRecovery() });
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
