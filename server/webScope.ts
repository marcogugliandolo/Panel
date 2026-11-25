/**
 * Qué webs vigila el panel. Dos ajustes, activados de serie:
 *
 * «Solo las webs de Nginx Proxy Manager»: las que no están en ningún NPM se quitan (también las que
 * se borren de NPM después). Las que siguen en NPM pero desactivadas o con la configuración rota
 * («Offline» en NPM) se apartan.
 *
 * «Solo las webs que funcionan»: se apartan las que no han respondido nunca desde que se vigilan y
 * las que llevan un día entero sin responder. Una web que funcionaba y se cae se queda (para eso
 * están los avisos); si sigue caída un día, se aparta.
 *
 * Las apartadas se comprueban cada 10 minutos y vuelven solas a la lista en cuanto responden (y,
 * con el primer ajuste, están bien en NPM). Con «Vigilar igualmente» se fija una web para que no se
 * aparte; con «Olvidar» se quita del todo. Sin datos de NPM, o si el panel no ha podido comprobar nada últimamente, no se toca nada.
 */
import express from 'express';
import type { Monitor } from '../shared/types';
import type { DB } from './db';
import { probeUrl } from './monitors';

const NPM_ONLY = 'webs_only_npm';
const ONLY_WORKING = 'webs_only_working';
const PINNED = 'webs_pinned';
const LAST = 'webs_only_npm_last';
const LAST_RESTORED = 'webs_restored_last';

const EVERY_MS = 2 * 60_000;
/** Lo automático solo actúa si la situación dura este rato (por si un envío del script llega incompleto). */
const GRACE_MS = Number(process.env.WEBS_PRUNE_GRACE_MS) || 4 * 60_000;
/** Una web nueva que no ha respondido nunca en este tiempo se aparta. */
const NEVER_MS = Number(process.env.WEBS_NEVER_MS) || 3 * 60_000;
/** Una web que funcionaba se aparta si lleva este tiempo sin responder. */
const DOWN_MS = Number(process.env.WEBS_DOWN_MS) || 24 * 3_600_000;
/** Cada cuánto se vuelve a probar una web apartada. */
const RECHECK_MS = Number(process.env.WEBS_RECHECK_MS) || 10 * 60_000;

type Reason = 'never' | 'down' | 'npm';

interface DormantRow {
  host: string;
  name: string;
  url: string;
  reason: Reason;
  since: number;
  last_ok: number | null;
  last_probe: number | null;
  last_error: string | null;
}

interface Deps {
  monitors: { list(): Monitor[]; remove(id: number): void; add(name: string, url: string): number | null };
  npm: { npmStatus(hostname: string): 'active' | 'inactive' | 'absent' | null };
}

export function createWebScope(db: DB, { monitors, npm }: Deps) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_dormant (
      host TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      reason TEXT NOT NULL,
      since INTEGER NOT NULL,
      last_ok INTEGER,
      last_probe INTEGER,
      last_error TEXT
    );
  `);
  const get = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const set = (key: string, value: string) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  const json = <T>(key: string, fallback: T): T => {
    try {
      return (JSON.parse(get(key) ?? 'null') as T) ?? fallback;
    } catch {
      return fallback;
    }
  };

  const npmOnly = () => get(NPM_ONLY) !== '0';
  const onlyWorking = () => get(ONLY_WORKING) !== '0';
  const pinned = () => new Set(json<string[]>(PINNED, []));
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  /** Datos de cada web vigilada para decidir: desde cuándo, última vez que respondió, fallos recientes. */
  const facts = db.prepare(`
    SELECT m.id, m.name, m.url, m.created_at AS createdAt,
      (SELECT MAX(ts) FROM monitor_checks c WHERE c.monitor_id = m.id AND c.ok = 1) AS lastOk,
      (SELECT COUNT(*) FROM monitor_checks c WHERE c.monitor_id = m.id) AS checks,
      (SELECT COUNT(*) FROM monitor_checks c WHERE c.monitor_id = m.id AND c.ok = 0 AND c.ts > ?) AS recentFails
    FROM monitors m WHERE m.enabled = 1`);
  type Fact = { id: number; name: string; url: string; createdAt: number; lastOk: number | null; checks: number; recentFails: number };

  /** Webs vigiladas que no están en ningún NPM (null si aún no hay datos de NPM). */
  function outside(): Monitor[] | null {
    const list = monitors.list();
    if (!list.length) return [];
    const out: Monitor[] = [];
    for (const m of list) {
      const host = hostOf(m.url);
      if (!host) continue;
      const st = npm.npmStatus(host);
      if (st === null) return null;
      if (st === 'absent') out.push(m);
    }
    return out;
  }

  /** Qué hacer con cada web ahora mismo: quitarla (no está en NPM) o apartarla (y por qué). */
  function verdicts(now: number) {
    const keep = pinned();
    const remove: Fact[] = [];
    const aside: { fact: Fact; reason: Reason }[] = [];
    const rows = facts.all(now - 30 * 60_000) as Fact[];
    for (const f of rows) {
      const host = hostOf(f.url);
      if (!host) continue;
      if (npmOnly()) {
        const st = npm.npmStatus(host);
        if (st === 'absent') {
          remove.push(f);
          continue;
        }
        if (st === 'inactive' && !keep.has(host)) {
          aside.push({ fact: f, reason: 'npm' });
          continue;
        }
      }
      if (!onlyWorking() || keep.has(host)) continue;
      // Solo cuando el panel la está comprobando de verdad (no tras estar el propio panel parado).
      if (f.lastOk === null && f.checks >= 3 && now - f.createdAt >= NEVER_MS) aside.push({ fact: f, reason: 'never' });
      else if (f.lastOk !== null && now - f.lastOk >= DOWN_MS && f.recentFails >= 3) aside.push({ fact: f, reason: 'down' });
    }
    return { remove, aside };
  }

  /** Desde cuándo dura cada situación (para lo automático). */
  const since = new Map<string, number>();
  const lasting = (key: string, now: number) => {
    if (!since.has(key)) since.set(key, now);
    return now - since.get(key)! >= GRACE_MS;
  };

  const putDormant = db.prepare(
    `INSERT INTO web_dormant (host, name, url, reason, since, last_ok, last_probe, last_error) VALUES (@host, @name, @url, @reason, @since, @lastOk, @since, NULL)
     ON CONFLICT(host) DO UPDATE SET name = excluded.name, url = excluded.url, reason = excluded.reason, since = excluded.since, last_ok = excluded.last_ok, last_probe = excluded.last_probe`,
  );

  /** Aplica las reglas. `patient`: lo automático espera a que la situación dure (GRACE_MS). */
  function apply(reason: string, now = Date.now(), patient = false) {
    // Sin datos de NPM, npmStatus da null y las reglas de NPM no quitan ni apartan nada.
    const { remove, aside } = verdicts(now);
    const seen = new Set<string>();
    const removed: string[] = [];
    for (const f of remove) {
      seen.add(`r${f.id}`);
      if (patient && !lasting(`r${f.id}`, now)) continue;
      monitors.remove(f.id);
      removed.push(f.name);
    }
    const setAside: string[] = [];
    for (const { fact: f, reason: why } of aside) {
      const key = `a${f.id}:${why}`;
      seen.add(key);
      // «No responde» ya es una situación que dura (minutos u horas): solo lo de NPM necesita margen.
      if (patient && why === 'npm' && !lasting(key, now)) continue;
      const host = hostOf(f.url)!;
      putDormant.run({ host, name: f.name, url: f.url, reason: why, since: now, lastOk: f.lastOk });
      monitors.remove(f.id);
      setAside.push(f.name);
    }
    for (const key of [...since.keys()]) if (!seen.has(key)) since.delete(key);
    if (removed.length) {
      set(LAST, JSON.stringify({ at: now, names: removed }));
      console.log(`[webs] ${reason}: se dejan de vigilar ${removed.length} web(s) que no están en Nginx Proxy Manager: ${removed.join(', ')}`);
    }
    if (setAside.length) console.log(`[webs] ${reason}: se apartan ${setAside.length} web(s) que no funcionan: ${setAside.join(', ')}`);
    return { removed, setAside };
  }

  /** Vuelve a probar las apartadas; las que responden (y están bien en NPM) vuelven a vigilarse. */
  let rechecking = false;
  async function recheck(force = false) {
    if (rechecking) return [];
    rechecking = true;
    const back: string[] = [];
    try {
      const now = Date.now();
      const rows = db.prepare('SELECT * FROM web_dormant').all() as DormantRow[];
      const due = rows.filter((r) => force || now - (r.last_probe ?? 0) >= RECHECK_MS);
      const queue = [...due];
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          const st = npm.npmStatus(r.host);
          // Si se ha borrado de NPM, se olvida.
          if (npmOnly() && st === 'absent') {
            db.prepare('DELETE FROM web_dormant WHERE host = ?').run(r.host);
            continue;
          }
          if (npmOnly() && st === 'inactive') {
            db.prepare('UPDATE web_dormant SET reason = ?, last_probe = ?, last_error = ? WHERE host = ?').run('npm', Date.now(), 'Desactivada o con error en NPM', r.host);
            continue;
          }
          const probe = await probeUrl(r.url);
          if (probe.ok) {
            db.prepare('DELETE FROM web_dormant WHERE host = ?').run(r.host);
            if (!monitors.list().some((m) => hostOf(m.url) === r.host)) monitors.add(r.name, r.url);
            back.push(r.name);
          } else {
            db.prepare('UPDATE web_dormant SET last_probe = ?, last_error = ?, reason = CASE WHEN reason = ? THEN ? ELSE reason END WHERE host = ?').run(
              Date.now(),
              probe.error,
              'npm',
              r.last_ok ? 'down' : 'never',
              r.host,
            );
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (back.length) {
        set(LAST_RESTORED, JSON.stringify({ at: Date.now(), names: back }));
        console.log(`[webs] Vuelven a responder y se vigilan otra vez: ${back.join(', ')}`);
      }
    } finally {
      rechecking = false;
    }
    return back;
  }

  function state() {
    const list = outside();
    const dormant = (db.prepare('SELECT * FROM web_dormant ORDER BY name COLLATE NOCASE').all() as DormantRow[]).map((r) => ({
      host: r.host,
      name: r.name,
      url: r.url,
      reason: r.reason,
      since: r.since,
      lastOk: r.last_ok,
      lastProbe: r.last_probe,
      lastError: r.last_error,
    }));
    return {
      npmOnly: npmOnly(),
      onlyWorking: onlyWorking(),
      ready: list !== null,
      outside: (list ?? []).map((m) => ({ id: m.id, name: m.name, url: m.url })),
      lastPruned: json<{ at: number; names: string[] } | null>(LAST, null),
      lastRestored: json<{ at: number; names: string[] } | null>(LAST_RESTORED, null),
      dormant,
    };
  }

  const router = express.Router();
  router.get('/', (_req, res) => res.json(state()));
  /** Cambia los ajustes. Al activar uno se aplica ya (sin esperar). */
  router.put('/', (req, res) => {
    if (typeof req.body?.npmOnly === 'boolean') set(NPM_ONLY, req.body.npmOnly ? '1' : '0');
    if (typeof req.body?.onlyWorking === 'boolean') set(ONLY_WORKING, req.body.onlyWorking ? '1' : '0');
    if (req.body?.npmOnly || req.body?.onlyWorking) apply('Ajuste activado');
    // Al desactivar «solo las que funcionan», las apartadas por no responder vuelven a la lista.
    if (req.body?.onlyWorking === false) restoreAll(['never', 'down']);
    if (req.body?.npmOnly === false) restoreAll(['npm']);
    res.json(state());
  });
  /** Quitar ya las que no están en NPM y apartar las que no funcionan. */
  router.post('/prune', (_req, res) => {
    const result = apply('A mano');
    res.json({ ...result, ...state() });
  });
  /** Volver a probar ya las apartadas. */
  router.post('/recheck', async (_req, res) => {
    const back = await recheck(true);
    res.json({ back, ...state() });
  });
  /** «Olvidar»: deja de probarse y no vuelve (tampoco desde NPM ni la búsqueda de webs). */
  router.post('/forget', (req, res) => {
    const hosts: string[] = req.body?.all
      ? (db.prepare('SELECT host FROM web_dormant').all() as { host: string }[]).map((r) => r.host)
      : [String(req.body?.host ?? '').toLowerCase()].filter(Boolean);
    for (const host of hosts) {
      db.prepare('DELETE FROM web_dormant WHERE host = ?').run(host);
      try {
        db.prepare(
          `INSERT INTO web_candidates (host, source, checked_at, dismissed) VALUES (?, 'npm', ?, 1) ON CONFLICT(host) DO UPDATE SET dismissed = 1`,
        ).run(host, Date.now());
      } catch {
        /* sin búsqueda de webs todavía */
      }
    }
    if (hosts.length) console.log(`[webs] Olvidadas ${hosts.length} web(s) apartadas: ${hosts.join(', ')}`);
    res.json(state());
  });
  /** «Vigilar igualmente»: vuelve a la lista y no se aparta aunque no funcione. */
  router.post('/keep', (req, res) => {
    const host = String(req.body?.host ?? '').toLowerCase();
    const row = db.prepare('SELECT * FROM web_dormant WHERE host = ?').get(host) as DormantRow | undefined;
    if (!row) return res.status(404).json({ error: 'Esa web no está apartada' });
    set(PINNED, JSON.stringify([...new Set([...pinned(), host])]));
    db.prepare('DELETE FROM web_dormant WHERE host = ?').run(host);
    if (!monitors.list().some((m) => hostOf(m.url) === host)) monitors.add(row.name, row.url);
    res.json(state());
  });

  function restoreAll(reasons: Reason[]) {
    const rows = db.prepare(`SELECT * FROM web_dormant WHERE reason IN (${reasons.map(() => '?').join(',')})`).all(...reasons) as DormantRow[];
    for (const r of rows) {
      db.prepare('DELETE FROM web_dormant WHERE host = ?').run(r.host);
      if (!monitors.list().some((m) => hostOf(m.url) === r.host)) monitors.add(r.name, r.url);
    }
  }

  return {
    router,
    npmOnly,
    /** ¿Está apartada? (para no volver a importarla desde NPM mientras no funcione) */
    isDormant: (host: string) => Boolean(db.prepare('SELECT 1 FROM web_dormant WHERE host = ?').get(host.toLowerCase())),
    start() {
      const run = () => {
        if (npmOnly() || onlyWorking()) apply('Automático', Date.now(), true);
        void recheck();
      };
      setTimeout(run, 30_000).unref();
      setInterval(run, Math.min(EVERY_MS, GRACE_MS)).unref();
    },
  };
}
