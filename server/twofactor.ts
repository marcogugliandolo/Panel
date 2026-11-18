/*
 * Doble factor (TOTP, RFC 6238) para el acceso al panel.
 *
 * Códigos de 6 cifras cada 30 s, compatibles con Google Authenticator, Aegis, 1Password, Bitwarden…
 * El secreto y los códigos de recuperación (solo su hash) se guardan en la tabla settings de la base de datos.
 */
import crypto from 'node:crypto';
import type { DB } from './db';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Se aceptan el código anterior y el siguiente, por si el reloj del móvil va algo desfasado. */
const DRIFT_STEPS = 1;
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Código TOTP de un paso de tiempo concreto. */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** Devuelve el paso de tiempo que coincide con el código, o null. */
export function matchTotp(secret: Buffer, code: string, now = Date.now()): number | null {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== DIGITS) return null;
  const step = currentStep(now);
  let found: number | null = null;
  // Se recorren todos los pasos de la ventana para no cortar antes de tiempo (tiempo de respuesta constante).
  for (let delta = -DRIFT_STEPS; delta <= DRIFT_STEPS; delta++) {
    const candidate = totpAt(secret, step + delta);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) found = step + delta;
  }
  return found;
}

const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'Server Panel'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function newSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** Estado del doble factor guardado en la base de datos. */
export function createTwoFactorStore(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const delStmt = db.prepare("DELETE FROM settings WHERE key LIKE 'totp_%'");
  const get = (key: string) => (getStmt.get(key) as { value: string } | undefined)?.value ?? null;
  const set = (key: string, value: string) => setStmt.run(key, value);

  function recoveryHashes(): string[] {
    try {
      return JSON.parse(get('totp_recovery') || '[]') as string[];
    } catch {
      return [];
    }
  }

  return {
    isEnabled: () => Boolean(get('totp_secret')),
    status() {
      const enabledAt = Number(get('totp_enabled_at')) || null;
      return { enabled: Boolean(get('totp_secret')), enabledAt, recoveryLeft: recoveryHashes().length };
    },

    /** Activa el doble factor con un secreto ya confirmado. Devuelve los códigos de recuperación en claro (solo esta vez). */
    enable(secretB32: string, confirmedStep: number): string[] {
      const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
      db.transaction(() => {
        set('totp_secret', secretB32);
        set('totp_last_step', String(confirmedStep));
        set('totp_enabled_at', String(Date.now()));
        set('totp_recovery', JSON.stringify(codes.map((c) => sha256Hex(normalizeRecovery(c)))));
      })();
      return codes;
    },

    disable() {
      delStmt.run();
    },

    regenerateRecovery(): string[] {
      const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
      set('totp_recovery', JSON.stringify(codes.map((c) => sha256Hex(normalizeRecovery(c)))));
      return codes;
    },

    /**
     * Comprueba un código de la app o de recuperación.
     * Un código de la app no se puede reutilizar (ni uno anterior) y uno de recuperación se gasta al usarlo.
     */
    verify(code: string): { ok: false } | { ok: true; usedRecovery: boolean; recoveryLeft: number } {
      const secret = get('totp_secret');
      if (!secret) return { ok: false };
      const digits = code.replace(/\s/g, '');
      if (/^\d{6}$/.test(digits)) {
        const step = matchTotp(base32Decode(secret), digits);
        const last = Number(get('totp_last_step')) || 0;
        if (step === null || step <= last) return { ok: false };
        set('totp_last_step', String(step));
        return { ok: true, usedRecovery: false, recoveryLeft: recoveryHashes().length };
      }
      const hash = sha256Hex(normalizeRecovery(code));
      const hashes = recoveryHashes();
      const index = hashes.findIndex((h) => crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
      if (index === -1) return { ok: false };
      hashes.splice(index, 1);
      set('totp_recovery', JSON.stringify(hashes));
      return { ok: true, usedRecovery: true, recoveryLeft: hashes.length };
    },
  };
}

export type TwoFactorStore = ReturnType<typeof createTwoFactorStore>;
