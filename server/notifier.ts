/*
 * Avisos por Telegram.
 *
 * Cada 10 segundos se revisa, en el propio servidor (sin depender de que haya un navegador abierto), lo mismo que la
 * campana del panel: servidores que no envían datos, contenedores caídos, webs caídas y certificados a punto de
 * caducar (y, si se activa, CPU/RAM/disco altos). Se avisa al caerse y al recuperarse, todo lo nuevo de una
 * revisión junto en un solo mensaje.
 *
 * El estado vive en la tabla notify_state, así que reiniciar el panel no repite avisos ya enviados. Si Telegram
 * falla, lo pendiente se reintenta en la siguiente revisión.
 */
import express from 'express';
import { THRESHOLDS, type Monitor, type ServerStats } from '../shared/types';
import { exitCode, isContainerProblem } from '../shared/health';
import { config } from './config';
import type { DB } from './db';
import { readLayout } from './routes/layout';
import { readAllStats } from './routes/stats';
import { escapeHtml as esc, getMe, isTokenLike, recentChats, sendMessage, TelegramError } from './telegram';

export interface NotifyRules {
  servers: boolean;
  containers: boolean;
  webs: boolean;
  certs: boolean;
  resources: boolean;
  /** Avisar también de los contenedores que se paran desde el propio panel. */
  manualStops: boolean;
}
const DEFAULT_RULES: NotifyRules = { servers: true, containers: true, webs: true, certs: true, resources: false, manualStops: false };

type Kind = 'server' | 'container' | 'web' | 'cert' | 'resource';
/** CPU, RAM o disco tienen que seguir altos este tiempo antes de avisar. */
const RESOURCE_MIN_MS = 5 * 60_000;
/** Un contenedor parado hace menos de esto puede ser un reinicio o una actualización: se espera al siguiente envío. */
const FRESH_STOP_SEC = 20;
/** Una parada hecha desde el panel no avisa; se olvida al volver a arrancar o, como mucho, en una semana. */
const MANUAL_STOP_MS = 7 * 86_400_000;
/**
 * Un contenedor cuenta como "servicio" (y avisa si se para, aunque sea con código 0) si se le ha visto en marcha al
 * menos este tiempo seguido. Así las tareas puntuales que arrancan, hacen su trabajo y terminan no avisan.
 */
const SERVICE_MIN_MS = 3 * 60_000;
/** Si entre dos revisiones en marcha pasa más que esto, se empieza a contar de nuevo. */
const RUNNING_GAP_MS = 4 * 60_000;
/** Un contenedor que desaparece de la lista y no vuelve en este tiempo se da por eliminado y se olvida. */
const FORGET_MISSING_MS = 3 * 86_400_000;

interface Condition {
  key: string;
  group: string;
  kind: Kind;
  /** Línea del aviso de caída (HTML). */
  down: string;
  /** Desde cuándo está mal, si se sabe (un servidor: desde su último envío). */
  since?: number;
  /** Hora del envío de métricas en que se ha visto (para contenedores). */
  obs?: number;
  /** Hay que verlo también en el siguiente envío antes de avisar (puede ser un reinicio de segundos). */
  needsSecondReport?: boolean;
  /** Tiempo mínimo que tiene que durar antes de avisar. */
  minAgeMs?: number;
}
interface StateRow {
  key: string;
  grp: string;
  kind: Kind;
  since: number;
  seen: number;
  notified: number;
  down_text: string;
  first_obs: number;
}

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
const pct = (v: number) => `${Math.round(v)} %`;
const dateEs = (ts: number) => new Date(ts).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' });

function certBucket(days: number): number {
  if (days < 0) return 0;
  if (days < 1) return 1;
  if (days < 3) return 3;
  if (days < 7) return 7;
  return 14;
}

/** Segundos desde que paró, a partir del texto de Docker («Exited (0) 2 minutes ago»). */
function stoppedAgoSec(status?: string | null): number | null {
  const m = /exited \(\d+\)\s+(.+?)\s+ago/i.exec(status ?? '');
  if (!m) return null;
  const t = m[1].toLowerCase();
  if (t.startsWith('less than')) return 0;
  if (t.startsWith('about a minute')) return 60;
  if (t.startsWith('about an hour')) return 3600;
  const n = /^(\d+)\s+(second|minute|hour|day|week|month|year)/.exec(t);
  if (!n) return null;
  const unit: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 };
  return Number(n[1]) * unit[n[2]];
}
/** ¿Hay que esperar al siguiente envío para estar seguros de que no es un reinicio de segundos? */
function stopNeedsConfirmation(c: { state: string; status?: string | null }): boolean {
  if (c.state === 'exited') {
    const ago = stoppedAgoSec(c.status);
    return ago === null || ago < FRESH_STOP_SEC;
  }
  // LXC/VM apagadas, en pausa o muertas no son un paso intermedio de nada: se avisa ya.
  return !['stopped', 'paused', 'dead'].includes(c.state);
}

const CONTAINER_LABEL: Record<string, string> = {
  exited: 'parado',
  stopped: 'apagado',
  restarting: 'reiniciándose sin parar',
  dead: 'muerto',
  paused: 'en pausa',
  created: 'creado pero sin arrancar',
  removing: 'eliminándose',
};
function containerProblemText(c: { state: string; status?: string | null }) {
  const code = exitCode(c);
  const label = CONTAINER_LABEL[c.state] ?? c.state;
  return code ? `${label} con error (código ${code})` : label;
}

export function createNotifier(db: DB, monitors: { list(): Monitor[] }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notify_state (
      key TEXT PRIMARY KEY,
      grp TEXT NOT NULL,
      kind TEXT NOT NULL,
      since INTEGER NOT NULL,
      seen INTEGER NOT NULL DEFAULT 1,
      notified INTEGER NOT NULL DEFAULT 0,
      down_text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notify_containers (
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      running_since INTEGER NOT NULL,
      last_running INTEGER NOT NULL,
      PRIMARY KEY (server_id, name)
    );
  `);
  const stateColumns = (db.prepare('PRAGMA table_info(notify_state)').all() as { name: string }[]).map((c) => c.name);
  if (!stateColumns.includes('first_obs')) db.exec('ALTER TABLE notify_state ADD COLUMN first_obs INTEGER NOT NULL DEFAULT 0');
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const get = (key: string) => (getStmt.get(key) as { value: string } | undefined)?.value ?? null;
  const set = (key: string, value: string) => setStmt.run(key, value);
  const del = (key: string) => db.prepare('DELETE FROM settings WHERE key = ?').run(key);

  const bootAt = Date.now();
  let lastError: string | null = null;
  let lastSentAt: number | null = Number(get('tg_last_sent')) || null;
  let running = false;

  /* --- Configuración --- */
  const fromEnv = () => Boolean(config.telegramToken && config.telegramChatId);
  const token = () => (fromEnv() ? config.telegramToken : get('tg_token'));
  const chatId = () => (fromEnv() ? config.telegramChatId : get('tg_chat_id'));
  const panelUrl = () => get('tg_panel_url');
  const active = () => Boolean(token() && chatId());
  function rules(): NotifyRules {
    try {
      return { ...DEFAULT_RULES, ...JSON.parse(get('tg_rules') || '{}') };
    } catch {
      return DEFAULT_RULES;
    }
  }

  /* --- Paradas hechas a mano desde el panel --- */
  function manualStops(): Record<string, number> {
    try {
      return JSON.parse(get('tg_manual_stops') || '{}');
    } catch {
      return {};
    }
  }
  const manualKey = (serverId: string, name: string) => `${serverId}|${name}`;

  /** Lo llama la ruta de Portainer al parar, arrancar o reiniciar un contenedor desde el panel. */
  function containerAction(endpointId: number, name: string, action: string) {
    const serverIds = readLayout(db)
      .layout.nodes.filter((n) => n.serverId && n.portainerEndpointId === endpointId)
      .map((n) => n.serverId!);
    if (!serverIds.length) return;
    const stops = manualStops();
    for (const sid of serverIds) {
      if (action === 'stop') stops[manualKey(sid, name)] = Date.now();
      else delete stops[manualKey(sid, name)];
    }
    set('tg_manual_stops', JSON.stringify(stops));
  }

  /* --- Qué está mal ahora mismo --- */
  interface Evaluation {
    conditions: Map<string, Condition>;
    /** Grupos vigilados en esta revisión, con la línea que se envía si se recuperan. */
    present: Map<string, string>;
    /** Grupos de los que ahora no se sabe nada (servidor caído, panel recién arrancado…): se deja el estado como está. */
    unknown: Set<string>;
  }

  function evaluate(now = Date.now()): Evaluation {
    const r = rules();
    const conditions = new Map<string, Condition>();
    const present = new Map<string, string>();
    const unknown = new Set<string>();
    const add = (c: Condition) => conditions.set(c.key, c);

    const statsById = new Map<string, ServerStats>(readAllStats(db, now).map((s) => [s.serverId, s]));
    // Recién arrancado el panel, la última métrica de cada servidor es vieja aunque el servidor esté bien.
    const warmingUp = now - bootAt < 120_000;
    const stops = manualStops();
    let stopsChanged = false;
    const seenServers = new Set<string>();

    // Todos los servidores que envían métricas, con el nombre del esquema si lo tienen.
    const titles = new Map<string, string>();
    for (const node of readLayout(db).layout.nodes) if (node.serverId && !titles.has(node.serverId)) titles.set(node.serverId, node.title || node.serverId);
    for (const stats of statsById.values()) {
      const sid = stats.serverId;
      if (seenServers.has(sid)) continue;
      seenServers.add(sid);
      const name = esc(titles.get(sid) || stats.hostname || sid);
      const serverGroup = `server:${sid}`;
      const containerGroups = () => stats.containers.map((c) => `container:${sid}:${c.name}`);
      const resourceGroups = ['cpu', 'ram', 'disk'].map((k) => `res:${sid}:${k}`);

      if (!stats.online) {
        if (warmingUp) {
          unknown.add(serverGroup);
        } else if (r.servers) {
          present.set(serverGroup, `🟢 <b>${name}</b> vuelve a responder`);
          add({ key: `${serverGroup}:offline`, group: serverGroup, kind: 'server', down: `🔴 <b>${name}</b> no responde (sin datos desde hace ${duration(now - stats.lastUpdated)})`, since: stats.lastUpdated });
        }
        // Con el servidor caído no se sabe nada de sus contenedores ni de su CPU.
        for (const g of [...containerGroups(), ...resourceGroups]) unknown.add(g);
        for (const row of db.prepare("SELECT grp FROM notify_state WHERE grp LIKE ? OR grp LIKE ?").all(`container:${sid}:%`, `res:${sid}:%`) as { grp: string }[]) unknown.add(row.grp);
        continue;
      }
      if (r.servers) present.set(serverGroup, `🟢 <b>${name}</b> vuelve a responder`);

      if (r.containers) {
        const memory = new Map(
          (db.prepare('SELECT name, running_since, last_running FROM notify_containers WHERE server_id = ?').all(sid) as {
            name: string;
            running_since: number;
            last_running: number;
          }[]).map((m) => [m.name, m]),
        );
        const listed = new Set<string>();
        const known = stats.containers.filter((c) => c.state !== 'unknown');
        for (const c of known) {
          listed.add(c.name);
          const group = `container:${sid}:${c.name}`;
          const mk = manualKey(sid, c.name);
          if (c.state === 'running') {
            const m = memory.get(c.name);
            const since = m && now - m.last_running <= RUNNING_GAP_MS ? m.running_since : now;
            db.prepare(
              `INSERT INTO notify_containers (server_id, name, running_since, last_running) VALUES (?, ?, ?, ?)
               ON CONFLICT(server_id, name) DO UPDATE SET running_since = excluded.running_since, last_running = excluded.last_running`,
            ).run(sid, c.name, since, now);
          }
          if (stops[mk] && (c.state === 'running' || now - stops[mk] > MANUAL_STOP_MS)) {
            delete stops[mk];
            stopsChanged = true;
          }
          if (stops[mk] && !r.manualStops) continue; // parado a propósito desde el panel: ni avisa ni "se recupera"
          const cname = esc(c.name);
          present.set(group, c.state === 'running' ? `🟢 <b>${cname}</b> en ${name} vuelve a estar en marcha` : `🟢 <b>${cname}</b> en ${name} ya no da error`);
          if (c.state === 'running') continue;
          const m = memory.get(c.name);
          const wasService = Boolean(m && m.last_running - m.running_since >= SERVICE_MIN_MS);
          if (isContainerProblem(c) || wasService) {
            const why = stops[mk] ? `${containerProblemText(c)} desde el panel` : containerProblemText(c);
            add({
              key: group,
              group,
              kind: 'container',
              down: `🔴 Contenedor <b>${cname}</b> en <b>${name}</b>: ${why}`,
              since: m?.last_running,
              obs: stats.lastUpdated,
              needsSecondReport: stopNeedsConfirmation(c),
            });
          }
        }
        // Los que estaban en marcha y ya no aparecen en la lista (parados con el script antiguo, o eliminados).
        if (known.length > 0) {
          for (const m of memory.values()) {
            if (listed.has(m.name)) continue;
            const group = `container:${sid}:${m.name}`;
            if (now - m.last_running > FORGET_MISSING_MS) {
              db.prepare('DELETE FROM notify_containers WHERE server_id = ? AND name = ?').run(sid, m.name);
              continue;
            }
            if (m.last_running - m.running_since < SERVICE_MIN_MS) continue;
            const cname = esc(m.name);
            present.set(group, `🟢 <b>${cname}</b> en ${name} vuelve a estar en marcha`);
            add({
              key: group,
              group,
              kind: 'container',
              down: `🔴 Contenedor <b>${cname}</b> en <b>${name}</b>: ya no aparece (parado o eliminado)`,
              since: m.last_running,
              obs: stats.lastUpdated,
              needsSecondReport: true,
            });
          }
        }
      }

      if (r.resources) {
        const checks: [string, number | null, string, number][] = [
          ['cpu', stats.cpu, 'CPU', THRESHOLDS.cpu],
          ['ram', stats.ram, 'RAM', THRESHOLDS.ram],
          ['disk', stats.disk, 'Disco', THRESHOLDS.disk],
        ];
        for (const [k, value, label, limit] of checks) {
          if (value === null) continue;
          const group = `res:${sid}:${k}`;
          present.set(group, `🟢 <b>${name}</b>: ${label} de nuevo normal (${pct(value)})`);
          if (value > limit) add({ key: group, group, kind: 'resource', down: `🟠 <b>${name}</b>: ${label} al ${pct(value)}`, minAgeMs: RESOURCE_MIN_MS });
        }
      }
    }
    if (stopsChanged) set('tg_manual_stops', JSON.stringify(stops));

    for (const m of monitors.list()) {
      if (!m.enabled) continue;
      const wname = esc(m.name);
      if (r.webs) {
        const group = `web:${m.id}`;
        if (m.status === 'pending' || m.status === 'warning') unknown.add(group);
        else {
          present.set(group, `🟢 <b>${wname}</b> vuelve a responder`);
          if (m.status === 'down') {
            // Con el diagnóstico de la ruta, el aviso dice dónde está el fallo. Se espera un poco a que esté listo.
            const d = m.diagnosis && !m.diagnosis.ok ? m.diagnosis : null;
            const where = d ? `\n   ↳ <b>${esc(d.title)}</b>: ${esc(d.summary)}` : '';
            add({ key: `${group}:down`, group, kind: 'web', down: `🔴 Web caída: <b>${wname}</b> · ${esc(m.lastCheck?.error ?? 'no responde')}${where}`, minAgeMs: d ? 0 : 25_000 });
          }
        }
      }
      if (r.certs && m.cert?.expiresAt) {
        const group = `cert:${m.id}`;
        const days = Math.floor((m.cert.expiresAt - now) / 86_400_000);
        present.set(group, `🟢 Certificado de <b>${wname}</b> renovado (caduca el ${dateEs(m.cert.expiresAt)})`);
        if (days < THRESHOLDS.certDays) {
          const b = certBucket(days);
          const text = days < 0 ? `🔴 El certificado SSL de <b>${wname}</b> ha caducado` : `⚠️ El certificado SSL de <b>${wname}</b> caduca ${days === 0 ? 'hoy' : `en ${days} ${days === 1 ? 'día' : 'días'}`}`;
          add({ key: `${group}:${b}`, group, kind: 'cert', down: text });
        }
      }
    }
    return { conditions, present, unknown };
  }

  /* --- Revisión periódica --- */
  const allRows = () => db.prepare('SELECT * FROM notify_state').all() as StateRow[];

  async function tick(): Promise<void> {
    if (running || !active()) return;
    running = true;
    try {
      const now = Date.now();
      const { conditions, present, unknown } = evaluate(now);
      const rows = new Map(allRows().map((r) => [r.key, r]));

      db.transaction(() => {
        for (const c of conditions.values()) {
          const row = rows.get(c.key);
          if (row) db.prepare('UPDATE notify_state SET seen = seen + 1, down_text = ? WHERE key = ?').run(c.down, c.key);
          else
            db.prepare('INSERT INTO notify_state (key, grp, kind, since, seen, notified, down_text, first_obs) VALUES (?, ?, ?, ?, 1, 0, ?, ?)').run(
              c.key,
              c.group,
              c.kind,
              c.since ?? now,
              c.down,
              c.obs ?? now,
            );
        }
      })();

      const downs: StateRow[] = [];
      const ups: { row: StateRow; text: string }[] = [];
      const silent: string[] = [];
      for (const row of allRows()) {
        const current = conditions.get(row.key);
        if (current) {
          const secondReport = !current.needsSecondReport || (current.obs ?? 0) > row.first_obs;
          const oldEnough = !current.minAgeMs || now - row.since >= current.minAgeMs;
          if (!row.notified && secondReport && oldEnough) downs.push(row);
          continue;
        }
        if (unknown.has(row.grp)) continue;
        const sameGroupStillBad = [...conditions.values()].some((c) => c.group === row.grp);
        if (!row.notified || sameGroupStillBad || !present.has(row.grp)) {
          // No se llegó a avisar, ha cambiado de nivel (certificado) o ya no se vigila: se olvida sin mensaje.
          silent.push(row.key);
          continue;
        }
        const back = present.get(row.grp)!;
        const text = row.kind === 'cert' ? back : `${back} · ${row.kind === 'web' ? 'caída' : row.kind === 'resource' ? 'alta' : row.kind === 'container' ? 'parado' : 'caído'} ${duration(now - row.since)}`;
        ups.push({ row, text });
      }
      if (silent.length) db.prepare(`DELETE FROM notify_state WHERE key IN (${silent.map(() => '?').join(',')})`).run(...silent);
      if (!downs.length && !ups.length) return;

      const lines = [...downs.map((d) => d.down_text), ...ups.map((u) => u.text)];
      await send(lines.join('\n'));
      db.transaction(() => {
        for (const d of downs) db.prepare('UPDATE notify_state SET notified = 1 WHERE key = ?').run(d.key);
        for (const u of ups) db.prepare('DELETE FROM notify_state WHERE key = ?').run(u.row.key);
      })();
      console.log(`[telegram] Aviso enviado: ${downs.length} caída(s), ${ups.length} recuperación(es)`);
    } catch (error) {
      const message = error instanceof TelegramError ? error.message : String((error as Error)?.message ?? error);
      if (message !== lastError) console.error('[telegram] No se pudo avisar:', message);
      lastError = message;
    } finally {
      running = false;
    }
  }

  async function send(html: string) {
    await sendMessage(token()!, chatId()!, html, panelUrl());
    lastError = null;
    lastSentAt = Date.now();
    set('tg_last_sent', String(lastSentAt));
  }

  /** Lo que está mal ahora mismo, para el mensaje de prueba y para el diálogo del panel. */
  function currentProblems(): string[] {
    return [...evaluate().conditions.values()].map((c) => c.down);
  }

  /** Al conectar o al probar: se envía el resumen y lo que ya está caído se da por avisado (luego llega su recuperación). */
  async function sendSummary(intro: string) {
    const { conditions } = evaluate();
    const problems = [...conditions.values()];
    const body = problems.length
      ? `${intro}\n\nAhora mismo:\n${problems.map((p) => p.down).join('\n')}`
      : `${intro}\n\nAhora mismo todo está en orden ✅`;
    await send(body);
    const now = Date.now();
    db.transaction(() => {
      for (const c of problems) {
        db.prepare(
          `INSERT INTO notify_state (key, grp, kind, since, seen, notified, down_text, first_obs) VALUES (?, ?, ?, ?, 1, 1, ?, ?)
           ON CONFLICT(key) DO UPDATE SET notified = 1`,
        ).run(c.key, c.group, c.kind, c.since ?? now, c.down, c.obs ?? now);
      }
    })();
  }

  function status() {
    return {
      active: active(),
      source: fromEnv() ? 'env' : 'panel',
      bot: get('tg_bot_username') ? { username: get('tg_bot_username')!, name: get('tg_bot_name') ?? '' } : null,
      hasToken: Boolean(token()),
      chat: chatId() ? { id: chatId()!, title: fromEnv() ? chatId()! : (get('tg_chat_title') ?? chatId()!) } : null,
      rules: rules(),
      lastSentAt,
      lastError,
      problems: active() ? currentProblems() : [],
    };
  }

  /* --- Rutas para el panel (con sesión) --- */
  const router = express.Router();
  const fail = (res: express.Response, error: unknown, fallback: string) =>
    res.status(error instanceof TelegramError ? 502 : 500).json({ error: error instanceof TelegramError ? error.message : fallback });
  const envLocked = (res: express.Response) => {
    if (!fromEnv()) return false;
    res.status(409).json({ error: 'Telegram está configurado con variables del stack (TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID).' });
    return true;
  };

  router.get('/', (_req, res) => res.json(status()));

  router.post('/bot', async (req, res) => {
    if (envLocked(res)) return;
    const value = String(req.body?.token ?? '').trim();
    if (!isTokenLike(value)) {
      res.status(400).json({ error: 'Eso no parece un token de bot. Tiene esta forma: 123456789:AAH…' });
      return;
    }
    try {
      const me = await getMe(value);
      const previousBot = get('tg_bot_id');
      set('tg_token', value);
      set('tg_bot_id', String(me.id));
      set('tg_bot_username', me.username);
      set('tg_bot_name', me.name);
      if (previousBot !== String(me.id)) {
        del('tg_chat_id');
        del('tg_chat_title');
      }
      res.json(status());
    } catch (error) {
      fail(res, error, 'No se pudo comprobar el bot');
    }
  });

  router.get('/chats', async (_req, res) => {
    const t = token();
    if (!t) {
      res.status(400).json({ error: 'Primero pega el token del bot.' });
      return;
    }
    try {
      res.json(await recentChats(t));
    } catch (error) {
      fail(res, error, 'No se pudieron leer los chats');
    }
  });

  router.post('/chat', async (req, res) => {
    if (envLocked(res)) return;
    const id = String(req.body?.chatId ?? '').trim();
    const title = String(req.body?.title ?? '').slice(0, 120) || id;
    const url = String(req.body?.panelUrl ?? '').slice(0, 300);
    if (!/^-?\d{3,20}$/.test(id) || !get('tg_token')) {
      res.status(400).json({ error: 'Chat no válido' });
      return;
    }
    const previous = { id: get('tg_chat_id'), title: get('tg_chat_title') };
    set('tg_chat_id', id);
    set('tg_chat_title', title);
    if (/^https?:\/\//.test(url)) set('tg_panel_url', url);
    db.prepare('DELETE FROM notify_state').run();
    try {
      await sendSummary('✅ <b>Server Panel</b> conectado. Te avisaré aquí cuando algo se caiga y cuando vuelva.');
      console.log(`[telegram] Conectado al chat ${title}`);
      res.json(status());
    } catch (error) {
      if (previous.id) set('tg_chat_id', previous.id);
      else del('tg_chat_id');
      if (previous.title) set('tg_chat_title', previous.title);
      else del('tg_chat_title');
      fail(res, error, 'No se pudo enviar el mensaje');
    }
  });

  router.put('/rules', (req, res) => {
    const next = { ...rules() };
    for (const k of Object.keys(DEFAULT_RULES) as (keyof NotifyRules)[]) if (typeof req.body?.[k] === 'boolean') next[k] = req.body[k];
    set('tg_rules', JSON.stringify(next));
    res.json(status());
  });

  router.post('/test', async (_req, res) => {
    if (!active()) {
      res.status(400).json({ error: 'Telegram no está conectado' });
      return;
    }
    try {
      await sendSummary('🔔 Mensaje de prueba de <b>Server Panel</b>.');
      res.json(status());
    } catch (error) {
      fail(res, error, 'No se pudo enviar el mensaje');
    }
  });

  router.delete('/', (_req, res) => {
    if (envLocked(res)) return;
    for (const k of ['tg_token', 'tg_bot_id', 'tg_bot_username', 'tg_bot_name', 'tg_chat_id', 'tg_chat_title', 'tg_last_sent']) del(k);
    db.prepare('DELETE FROM notify_state').run();
    lastError = null;
    lastSentAt = null;
    console.log('[telegram] Desconectado');
    res.json(status());
  });

  return {
    router,
    containerAction,
    start() {
      if (fromEnv()) console.log('[telegram] Avisos activos (configurados con variables del stack)');
      else if (active()) console.log('[telegram] Avisos activos');
      setInterval(() => void tick(), config.notifyIntervalMs).unref();
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
