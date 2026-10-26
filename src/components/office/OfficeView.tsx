import { ChevronLeft, Phone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { THRESHOLDS, type Monitor, type PortainerEndpoint, type PortainerStatus } from '../../../shared/types';
import { api } from '../../api';
import { formatMs, formatPercent, timeAgo } from '../../lib/format';
import { emitOrder, newOrderId, onOrder } from '../../lib/orders';
import { containerStateMeta, HEALTH_META, isContainerProblem, MONITOR_META, type ServerView, type Tone } from '../../lib/status';
import { cn } from '../../lib/utils';
import { ServerDetails } from '../server/ServerDrawer';
import { Button, StatusBadge, useConfirm, useToast } from '../ui';
import { createScene, lookFor, paintPortrait, RECEPTION_KEY, type FloorKey, type Scene, type SceneMode, type SceneNetDevice, type SceneServer } from './scene';

const TEXT: Record<SceneMode, { title: string; hint: string; label: string }> = {
  oficina: {
    title: 'Oficina',
    hint: 'Todas las plantas juntas en un plano. Pulsa un empleado para ver su ficha y sus contenedores.',
    label: 'Plano de la oficina: cada servidor es un empleado en su mesa, la recepción vigila las webs, el CPD guarda el router y los racks, y desde el despacho llevas los encargos.',
  },
  edificio: {
    title: 'Edificio',
    hint: 'Cada planta es una zona de tu esquema. Pulsa una planta para verla en la oficina, o un empleado para ver su ficha.',
    label: 'Edificio de marcogugliandolo.com en corte: la antena de Internet en la azotea, tu despacho en el ático, los VPS en la planta 2, los equipos de casa y el CPD con el router en la planta 1, y la recepción abajo.',
  },
};

interface LogEntry {
  id: number;
  t: number;
  who: string;
  text: string;
  tone: Tone | 'info';
}

interface Props {
  mode: SceneMode;
  servers: ServerView[];
  /** Router y demás equipo de red del esquema, para el CPD. */
  network: SceneNetDevice[];
  monitors: Monitor[] | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onFloor: (floor: FloorKey) => void;
  onMonitorsChange: () => Promise<void>;
  portainer: PortainerStatus | null;
  endpoints: PortainerEndpoint[] | null;
  onLinkEndpoint: (nodeId: string, endpointId: number) => Promise<void>;
  /** Tras olvidar un servidor que ya no está en el esquema. */
  onForgotten: () => void;
  now: number;
}

/** En la oficina trabajan los mismos servidores que hay en el esquema de la vista Clásica. */
const inSchema = (s: ServerView) => Boolean(s.node && s.serverId);
/** Ids que enviaron métricas pero no están en el esquema (normalmente ids antiguos). */
const outsideSchema = (s: ServerView) => Boolean(!s.node && s.serverId);
/** Primero los VPS y luego los de casa; dentro de cada planta, por nombre (RPi-01 antes que RPi-02). */
const floorRank = (s: ServerView) => (s.node?.icon === 'Cloud' ? 0 : 1);
const byFloorAndName = (a: ServerView, b: ServerView) =>
  floorRank(a) - floorRank(b) || a.title.localeCompare(b.title, 'es', { numeric: true, sensitivity: 'base' });

function sceneServers(servers: ServerView[]): SceneServer[] {
  return servers
    .filter(inSchema)
    .sort(byFloorAndName)
    .map((s) => ({
      key: s.key,
      serverId: s.serverId!,
      title: s.title,
      floor: s.node?.icon === 'Cloud' ? 'nube' : 'casa',
      online: s.stats?.online ?? false,
      hasData: Boolean(s.stats),
      cpu: s.stats?.cpu ?? 0,
      ram: s.stats?.ram ?? 0,
      disk: s.stats?.disk ?? null,
      containers: s.stats?.containers ?? [],
    }));
}

/** Cómo está cada empleado, en palabras de la oficina. */
function moodOf(s: ServerView): { label: string; tone: Tone } {
  const st = s.stats;
  if (!st) return { label: 'Sin datos', tone: 'idle' };
  if (!st.online) return { label: 'Ausente', tone: 'bad' };
  if (st.containers.some(isContainerProblem)) return { label: 'Con problemas', tone: 'bad' };
  if ((st.cpu ?? 0) > THRESHOLDS.cpu || (st.ram ?? 0) > THRESHOLDS.ram || (st.disk ?? 0) > THRESHOLDS.disk) return { label: 'Agobiado', tone: 'warn' };
  if ((st.cpu ?? 0) < 12) return { label: 'Tranquilo', tone: 'ok' };
  return { label: 'Trabajando', tone: 'ok' };
}

function Portrait({ id, size = 'md' }: { id: string; size?: 'md' | 'lg' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintPortrait(ref.current, lookFor(id));
  }, [id]);
  return (
    <canvas
      ref={ref}
      width={22}
      height={20}
      aria-hidden
      className={cn('shrink-0 rounded-lg [image-rendering:pixelated]', size === 'lg' ? 'h-12 w-[52px]' : 'h-10 w-11')}
    />
  );
}

export function OfficeView({
  mode,
  servers,
  network,
  monitors,
  selectedKey,
  onSelect,
  onFloor,
  onMonitorsChange,
  portainer,
  endpoints,
  onLinkEndpoint,
  onForgotten,
  now,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ovOficinaRef = useRef<HTMLDivElement>(null);
  const ovEdificioRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const callbacks = useRef({ onSelect, onFloor });
  callbacks.current = { onSelect, onFloor };
  const [log, setLog] = useState<LogEntry[]>([]);
  const [, setTick] = useState(0);
  const logId = useRef(0);
  const pendingFocus = useRef<FloorKey | null>(null);

  const addLog = useCallback((who: string, text: string, tone: LogEntry['tone']) => {
    setLog((entries) => [{ id: ++logId.current, t: Date.now(), who, text, tone }, ...entries].slice(0, 80));
  }, []);

  // La escena vive mientras el panel esté abierto, aunque estés en la vista Clásica.
  useEffect(() => {
    const scene = createScene({
      canvas: canvasRef.current!,
      world: worldRef.current!,
      stageScroll: scrollRef.current!,
      overlays: { oficina: ovOficinaRef.current!, edificio: ovEdificioRef.current! },
      onSelect: (key) => callbacks.current.onSelect(key),
      onFloor: (floor) => {
        pendingFocus.current = floor;
        callbacks.current.onFloor(floor);
      },
    });
    sceneRef.current = scene;
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  const sceneData = useMemo(() => sceneServers(servers), [servers]);
  const webs = useMemo(
    () => (monitors ?? []).filter((m) => m.enabled).map((m) => ({ name: m.name, down: m.status === 'down', latencyMs: m.lastCheck?.latencyMs ?? null })),
    [monitors],
  );
  useEffect(() => sceneRef.current?.setData(sceneData, webs, network), [sceneData, webs, network]);
  useEffect(() => {
    sceneRef.current?.setMode(mode, pendingFocus.current ?? undefined);
    pendingFocus.current = null;
  }, [mode]);
  useEffect(() => sceneRef.current?.setSelected(selectedKey), [selectedKey]);

  // Encargos lanzados desde cualquier ficha (también desde la Clásica).
  const titles = useRef(new Map<string, string>());
  titles.current = new Map(servers.filter((s) => s.serverId).map((s) => [s.serverId!, s.title]));
  useEffect(
    () =>
      onOrder((ev) => {
        sceneRef.current?.order(ev);
        const name = ev.serverId === RECEPTION_KEY ? 'Recepción' : titles.current.get(ev.serverId) ?? ev.serverId;
        if (ev.phase === 'start') addLog(`Tú → ${name}`, ev.label, 'info');
        else addLog(name, ev.result ?? (ev.ok === false ? 'No se pudo hacer' : 'Hecho'), ev.ok === false ? 'bad' : 'ok');
      }),
    [addLog],
  );

  // Lo que va pasando: servidores que se van o vuelven, contenedores que fallan, webs que se caen.
  const previous = useRef<{ servers: Map<string, { online: boolean; failing: Set<string> }>; webs: Map<number, string> } | null>(null);
  useEffect(() => {
    const snapshot = {
      servers: new Map(
        servers
          .filter((s) => s.stats)
          .map((s) => [s.key, { online: s.stats!.online, failing: new Set(s.stats!.containers.filter(isContainerProblem).map((c) => c.name)) }]),
      ),
      webs: new Map((monitors ?? []).map((m) => [m.id, m.status])),
    };
    const prev = previous.current;
    if (prev) {
      for (const s of servers) {
        const before = prev.servers.get(s.key), after = snapshot.servers.get(s.key);
        if (!before || !after) continue;
        if (before.online && !after.online) addLog(s.title, 'Ha dejado de enviar métricas', 'bad');
        if (!before.online && after.online) addLog(s.title, 'Vuelve a enviar métricas', 'ok');
        for (const name of after.failing) {
          if (before.failing.has(name)) continue;
          const c = s.stats!.containers.find((x) => x.name === name)!;
          addLog(s.title, `${name}: ${containerStateMeta(c).label.toLowerCase()}`, 'bad');
        }
        for (const name of before.failing) if (!after.failing.has(name)) addLog(s.title, `${name} vuelve a estar bien`, 'ok');
      }
      for (const m of monitors ?? []) {
        const before = prev.webs.get(m.id);
        if (!before || before === m.status) continue;
        if (m.status === 'down') addLog('Recepción', `${m.name} no contesta`, 'bad');
        else if (before === 'down' && m.status === 'up') addLog('Recepción', `${m.name} vuelve a contestar`, 'ok');
      }
    }
    previous.current = snapshot;
  }, [servers, monitors, addLog]);

  // La plantilla enseña lo que dice cada uno en la escena.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 2000);
    return () => window.clearInterval(timer);
  }, []);

  // En pantallas estrechas, al elegir a alguien se baja hasta su ficha.
  useEffect(() => {
    if (selectedKey && window.matchMedia('(max-width: 1180px)').matches) sideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedKey]);

  const selected = selectedKey && selectedKey !== RECEPTION_KEY ? servers.find((s) => s.key === selectedKey) ?? null : null;
  const text = TEXT[mode];

  return (
    <div className="scrollbar-thin relative h-full overflow-y-auto">
      <div className="of-main">
        <section className="of-stage" aria-labelledby="of-title">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
            <h2 id="of-title" className="text-sm font-semibold">{text.title}</h2>
            <p className="text-[12.5px] text-ink-3">{text.hint}</p>
          </div>
          <div ref={scrollRef} className="scrollbar-thin overflow-x-auto overflow-y-hidden">
            <div ref={worldRef} className="sc-world">
              <canvas ref={canvasRef} role="img" aria-label={text.label} />
              <div ref={ovOficinaRef} className="sc-overlay" />
              <div ref={ovEdificioRef} className="sc-overlay" hidden />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 border-t border-line px-4 py-2.5 text-xs text-ink-3">
            <span className="text-ink-2 md:hidden">Desliza para ver toda la escena.</span>
            <span><b className="font-medium text-ink-2">Pantalla de la pared</b> CPU, RAM y disco</span>
            <span><b className="font-medium text-ink-2">Teclea más rápido</b> más CPU</span>
            <span><b className="font-medium text-ink-2">Papeles</b> RAM</span>
            <span><b className="font-medium text-ink-2">Notas del corcho</b> contenedores</span>
            <span><b className="font-medium text-ink-2">Silla vacía y luz apagada</b> sin datos</span>
            <span><b className="font-medium text-ink-2">Puntos por los cables</b> actividad</span>
            <span><b className="font-medium text-ink-2">Ascensor</b> tú llevando un encargo</span>
            <span><b className="font-medium text-ink-2">CPD</b> el router y un rack con una luz por equipo de casa</span>
          </div>
        </section>

        <aside ref={sideRef} className="of-side" aria-label="Plantilla y ficha">
          {selectedKey === RECEPTION_KEY ? (
            <ReceptionPanel monitors={monitors} onBack={() => onSelect(null)} onChange={onMonitorsChange} now={now} />
          ) : selected ? (
            <div key={selected.key} className="space-y-4">
              <button type="button" onClick={() => onSelect(null)} className="inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink">
                <ChevronLeft size={14} aria-hidden /> Plantilla
              </button>
              <div className="flex items-center gap-3">
                <Portrait id={selected.serverId ?? selected.key} size="lg" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[15px] font-semibold">{selected.title}</h2>
                    <StatusBadge tone={HEALTH_META[selected.health].tone} label={HEALTH_META[selected.health].label} />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-ink-3">
                    {selected.serverId}
                    {selected.stats?.hostname && selected.stats.hostname !== selected.serverId ? ` · ${selected.stats.hostname}` : ''}
                    {selected.node?.ip ? ` · ${selected.node.ip}` : ''}
                  </p>
                </div>
              </div>
              <p className="text-[13px] text-ink-2">
                <span className="label-caps mr-2">Ahora</span>
                {sceneRef.current?.doing(selected.key) || (selected.stats ? '—' : 'Esperando datos del script de métricas')}
              </p>
              <ServerDetails
                server={selected}
                portainer={portainer}
                endpoints={endpoints}
                now={now}
                onLinkEndpoint={onLinkEndpoint}
                initialTab="containers"
              />
              {!selected.node && selected.serverId && (
                <ForgetButton
                  serverId={selected.serverId}
                  title={selected.title}
                  onDone={() => {
                    onSelect(null);
                    onForgotten();
                  }}
                />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-[15px] font-semibold">La plantilla</h2>
                <p className="mt-1 text-[13px] text-ink-2">Cada servidor es un empleado de marcogugliandolo.com. Elige uno para ver su ficha y sus contenedores.</p>
              </div>
              <ul className="space-y-1.5">
                {servers
                  .filter(inSchema)
                  .sort(byFloorAndName)
                  .map((s) => {
                    const mood = moodOf(s);
                    const st = s.stats;
                    return (
                      <li key={s.key}>
                        <button
                          type="button"
                          onClick={() => onSelect(s.key)}
                          className="grid w-full grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-[10px] border border-line bg-surface-2 px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-3"
                        >
                          <Portrait id={s.serverId!} />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2 text-[13.5px] font-semibold">
                              {s.title}
                              <StatusBadge tone={mood.tone} label={mood.label} />
                            </span>
                            <span className="truncate text-[12.5px] text-ink-2">
                              {st && !st.online ? `Sin noticias ${timeAgo(st.lastUpdated, now)}` : sceneRef.current?.doing(s.key) || '—'}
                            </span>
                            <span className="truncate font-mono text-[11px] text-ink-3 tabular-nums">
                              {st ? `CPU ${formatPercent(st.cpu, 0)} · RAM ${formatPercent(st.ram, 0)} · Disco ${formatPercent(st.disk, 0)}` : 'Esperando datos del script'}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                <li>
                  <button
                    type="button"
                    onClick={() => onSelect(RECEPTION_KEY)}
                    className="grid w-full grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-[10px] border border-line bg-surface-2 px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-3"
                  >
                    <Portrait id={RECEPTION_KEY} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-[13.5px] font-semibold">
                        Recepción
                        {(() => {
                          const down = (monitors ?? []).filter((m) => m.status === 'down').length;
                          return <StatusBadge tone={down ? 'bad' : 'ok'} label={down ? 'Teléfono sonando' : 'Atendiendo'} />;
                        })()}
                      </span>
                      <span className="truncate text-[12.5px] text-ink-2">{sceneRef.current?.doing(RECEPTION_KEY) || '—'}</span>
                      <span className="truncate font-mono text-[11px] text-ink-3">
                        {(monitors ?? []).length} webs · {(monitors ?? []).filter((m) => m.status === 'down').length || 'ninguna'} sin contestar
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
              {servers.some(outsideSchema) && (
                <div className="space-y-2 border-t border-line pt-4">
                  <h3 className="label-caps">Fuera del esquema</h3>
                  <p className="text-xs text-ink-3">
                    Enviaron métricas con un id que no está en el esquema, así que no tienen mesa. Si es un id antiguo, ábrelo y pulsa «Olvidar».
                  </p>
                  <ul className="space-y-1">
                    {servers.filter(outsideSchema).map((s) => (
                      <li key={s.key}>
                        <button
                          type="button"
                          onClick={() => onSelect(s.key)}
                          className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-line px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:border-line-strong hover:bg-surface-2"
                        >
                          <span className="min-w-0 truncate">
                            <span className="font-mono text-ink">{s.serverId}</span>
                            {s.title !== s.serverId && <span className="text-ink-3"> · {s.title}</span>}
                          </span>
                          <span className="shrink-0 text-[11.5px] text-ink-3">
                            {s.stats?.online ? 'Enviando ahora' : s.stats ? `Última vez ${timeAgo(s.stats.lastUpdated, now)}` : 'Sin datos'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </aside>

        <section className="of-log" aria-labelledby="of-log-title">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 id="of-log-title" className="text-sm font-semibold">Registro de actividad</h2>
            <span className="label-caps">Desde que abriste el panel</span>
          </div>
          {log.length === 0 ? (
            <p className="py-2 text-[13px] text-ink-3">Todavía no ha pasado nada. Aquí aparecerán tus encargos y los cambios de estado de servidores, contenedores y webs.</p>
          ) : (
            <ol className="scrollbar-thin flex max-h-[280px] flex-col overflow-y-auto" aria-live="polite">
              {log.map((e) => (
                <li key={e.id} className="grid grid-cols-[42px_8px_minmax(0,1fr)] items-baseline gap-2.5 border-t border-line py-1.5 text-[13px] first:border-t-0">
                  <time className="font-mono text-[11.5px] text-ink-3 tabular-nums" dateTime={new Date(e.t).toISOString()}>
                    {new Date(e.t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <span
                    className={cn(
                      'size-1.5 self-center rounded-full',
                      e.tone === 'ok' ? 'bg-ok' : e.tone === 'bad' ? 'bg-bad' : e.tone === 'warn' ? 'bg-warn' : 'bg-info',
                    )}
                  />
                  <span>
                    <span className="font-medium text-ink-2">{e.who}</span> · {e.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

/** La recepción: los teléfonos son las webs vigiladas. */
function ReceptionPanel({ monitors, onBack, onChange, now }: { monitors: Monitor[] | null; onBack: () => void; onChange: () => Promise<void>; now: number }) {
  const [busy, setBusy] = useState<number | null>(null);
  const toast = useToast();

  async function check(m: Monitor) {
    setBusy(m.id);
    const order = { id: newOrderId(), serverId: RECEPTION_KEY, label: `Comprobar ${m.name}`, doing: `Llamando a ${m.name}` };
    emitOrder({ ...order, phase: 'start' });
    try {
      const result = await api.checkMonitor(m.id);
      const ok = Boolean(result.lastCheck?.ok);
      const text = ok ? `${m.name} contesta en ${formatMs(result.lastCheck?.latencyMs ?? null)}` : `${m.name}: ${result.lastCheck?.error ?? 'no contesta'}`;
      emitOrder({ ...order, phase: 'done', ok, result: text });
      toast(text, ok ? 'ok' : 'bad');
      await onChange();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'No se pudo comprobar';
      emitOrder({ ...order, phase: 'done', ok: false, result: text });
      toast(text, 'bad');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink">
        <ChevronLeft size={14} aria-hidden /> Plantilla
      </button>
      <div className="flex items-center gap-3">
        <Portrait id={RECEPTION_KEY} size="lg" />
        <div>
          <h2 className="text-[15px] font-semibold">Recepción</h2>
          <p className="mt-0.5 text-xs text-ink-3">Planta baja. Llama a cada web cada poco y avisa si no contesta.</p>
        </div>
      </div>
      {monitors === null ? (
        <p className="text-sm text-ink-3">Cargando webs…</p>
      ) : monitors.length === 0 ? (
        <p className="text-sm text-ink-3">No hay webs vigiladas.</p>
      ) : (
        <ul className="overflow-hidden rounded-[10px] border border-line">
          {monitors.map((m) => {
            const meta = MONITOR_META[m.status];
            return (
              <li key={m.id} className="flex items-center gap-3 border-t border-line px-3 py-2.5 first:border-t-0">
                <Phone size={14} className={cn('shrink-0', m.status === 'down' ? 'text-bad' : 'text-ink-3')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{m.name}</span>
                    <StatusBadge tone={meta.tone} label={meta.label} />
                  </span>
                  <span className="block truncate font-mono text-[11px] text-ink-3">
                    {m.lastCheck ? `${formatMs(m.lastCheck.latencyMs)} · ${formatPercent(m.uptime24h, 1)} hoy · ${timeAgo(m.lastCheck.ts, now)}` : 'Pendiente de la primera comprobación'}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => check(m)}
                  className="shrink-0 rounded-[7px] border border-line-strong bg-surface-2 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-3 disabled:opacity-40"
                >
                  {busy === m.id ? 'Llamando…' : 'Comprobar'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Para borrar servidores que ya no están en el esquema (ids antiguos que dejaron de enviar datos). */
function ForgetButton({ serverId, title, onDone }: { serverId: string; title: string; onDone: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  async function forget() {
    const ok = await confirm({
      title: `Olvidar ${title}`,
      message: (
        <p>
          No está en el esquema. Se borrarán sus métricas y su historial (<span className="font-mono text-ink">{serverId}</span>). Si su
          script sigue enviando datos, volverá a aparecer.
        </p>
      ),
      confirmLabel: 'Olvidar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.forgetServer(serverId);
      toast(`${title} olvidado`);
      onDone();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo borrar', 'bad');
    }
  }
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-xs text-ink-3">Este servidor no está en el esquema: solo aparece porque alguna vez envió métricas con este id.</p>
      <Button variant="danger" size="sm" icon={<Trash2 size={14} aria-hidden />} onClick={forget}>
        Olvidar este servidor
      </Button>
    </div>
  );
}
