/**
 * «Solo las webs de Nginx Proxy Manager»: con este ajuste (activado de serie), el panel vigila
 * únicamente las webs que están en algún NPM. Las demás se quitan solas, también las que se borren
 * de NPM más adelante. Mientras no se sepa nada de ningún NPM (script sin actualizar, NPM sin
 * conectar) no se quita nada.
 */
import express from 'express';
import type { Monitor } from '../shared/types';
import type { DB } from './db';

const KEY = 'webs_only_npm';
const LAST = 'webs_only_npm_last';
const EVERY_MS = 2 * 60_000;
/** Lo automático solo quita una web si sigue fuera de NPM tras este rato (por si un envío llega incompleto). */
const GRACE_MS = Number(process.env.WEBS_PRUNE_GRACE_MS) || 4 * 60_000;

interface Deps {
  monitors: { list(): Monitor[]; remove(id: number): void };
  npm: { inNpm(hostname: string): boolean | null };
}

export function createWebScope(db: DB, { monitors, npm }: Deps) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const get = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const set = (key: string, value: string) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  const npmOnly = () => get(KEY) !== '0';
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };

  /** Webs vigiladas que no están en ningún NPM (null si aún no hay datos de NPM). */
  function outside(): Monitor[] | null {
    const list = monitors.list();
    let known = false;
    const out: Monitor[] = [];
    for (const m of list) {
      const host = hostOf(m.url);
      if (!host) continue;
      const found = npm.inNpm(host);
      if (found === null) return null;
      known = true;
      if (!found) out.push(m);
    }
    return known || list.length === 0 ? out : null;
  }

  /** Desde cuándo está fuera de NPM cada web (para lo automático). */
  const outsideSince = new Map<number, number>();

  function prune(reason: string, now = Date.now(), patient = false): string[] {
    let list = outside();
    if (list === null) return [];
    if (patient) {
      const ids = new Set(list.map((m) => m.id));
      for (const id of [...outsideSince.keys()]) if (!ids.has(id)) outsideSince.delete(id);
      for (const m of list) if (!outsideSince.has(m.id)) outsideSince.set(m.id, now);
      list = list.filter((m) => now - outsideSince.get(m.id)! >= GRACE_MS);
    }
    if (!list.length) return [];
    for (const m of list) {
      monitors.remove(m.id);
      outsideSince.delete(m.id);
    }
    const names = list.map((m) => m.name);
    set(LAST, JSON.stringify({ at: Date.now(), names }));
    console.log(`[webs] ${reason}: se dejan de vigilar ${names.length} web(s) que no están en Nginx Proxy Manager: ${names.join(', ')}`);
    return names;
  }

  function state() {
    const list = outside();
    let last: { at: number; names: string[] } | null = null;
    try {
      last = JSON.parse(get(LAST) ?? 'null');
    } catch {
      last = null;
    }
    return {
      npmOnly: npmOnly(),
      ready: list !== null,
      outside: (list ?? []).map((m) => ({ id: m.id, name: m.name, url: m.url })),
      lastPruned: last,
    };
  }

  const router = express.Router();
  router.get('/', (_req, res) => res.json(state()));
  /** Cambia el ajuste. Al activarlo se quitan ya las que sobran. */
  router.put('/', (req, res) => {
    const on = Boolean(req.body?.npmOnly);
    set(KEY, on ? '1' : '0');
    if (on) prune('Activado «solo webs de NPM»');
    res.json(state());
  });
  /** Quitar ahora las que no están en NPM (sin cambiar el ajuste). */
  router.post('/prune', (_req, res) => {
    const removed = prune('A mano');
    res.json({ removed, ...state() });
  });

  return {
    router,
    npmOnly,
    start() {
      // Al arrancar se espera un poco a que lleguen los datos frescos de NPM; luego, cada 2 minutos.
      const run = () => npmOnly() && prune('Automático', Date.now(), true);
      setTimeout(run, 30_000).unref();
      setInterval(run, Math.min(EVERY_MS, GRACE_MS)).unref();
    },
  };
}
