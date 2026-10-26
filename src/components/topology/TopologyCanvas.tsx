import { Cable, Edit3, List, Maximize, Network, Plus, Save, SquareDashed, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import { THRESHOLDS, type Layout, type LayoutNode, type LayoutZone, type PortainerEndpoint } from '../../../shared/types';
import { nodeIcon } from '../../lib/icons';
import { HEALTH_META, type ServerView, type Tone } from '../../lib/status';
import { cn } from '../../lib/utils';
import { Button, useToast } from '../ui';
import { NodeEditor, ZoneEditor } from './LayoutEditors';

/** Colores del esquema tal como se ven en el panel desde el principio. */
const CLASSIC_COLOR: Record<Tone, string> = { ok: '#00ff9d', warn: '#ffcc00', bad: '#ff4444', idle: '#6e737c' };

const CANVAS_WIDTH = 1400;
const CANVAS_HEIGHT = 800;

const ZONE_STYLES: Record<LayoutZone['color'], { text: string; border: string; wash: string }> = {
  blue: { text: 'text-[#7fb2f5]', border: 'border-[#5a9cf0]/25', wash: 'from-[#5a9cf0]/[0.06]' },
  purple: { text: 'text-[#b9a6f7]', border: 'border-[#9d85f2]/25', wash: 'from-[#9d85f2]/[0.06]' },
  green: { text: 'text-[#6fe0b0]', border: 'border-[#3fcf8e]/25', wash: 'from-[#3fcf8e]/[0.06]' },
  amber: { text: 'text-[#f2c66d]', border: 'border-[#e8b44c]/25', wash: 'from-[#e8b44c]/[0.06]' },
};

type DragState = {
  id: string;
  kind: 'node' | 'zone' | 'resize';
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type Editing = { type: 'node'; item: LayoutNode; isNew: boolean } | { type: 'zone'; item: LayoutZone; isNew: boolean } | null;

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const snap = (value: number) => Math.round(value * 2) / 2;

interface Props {
  layout: Layout;
  servers: Map<string, ServerView>;
  endpoints: PortainerEndpoint[] | null;
  knownServerIds: string[];
  onSave: (layout: Layout) => Promise<void>;
  onSelect: (nodeId: string) => void;
  now: number;
  /** El modo edición se enciende y se apaga desde la cabecera (Editar Diseño / Terminar Edición). */
  isEditing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Cada incremento pide guardar el borrador (Terminar Edición). */
  saveSignal: number;
}

export function TopologyCanvas({ layout, servers, endpoints, knownServerIds, onSave, onSelect, now, isEditing: editingRequested, onEditingChange, saveSignal }: Props) {
  const [draft, setDraft] = useState<Layout | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null | undefined>(undefined); // undefined = modo conectar apagado
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ReactZoomPanPinchRef>(null);
  const toast = useToast();

  /*
   * Ajuste a la pantalla: encaja zonas y nodos (no el lienzo entero) en el hueco disponible, sea un móvil en
   * vertical o un monitor grande. Se repite al girar el móvil o cambiar el tamaño de la ventana, salvo que hayas
   * movido o ampliado el esquema a mano (entonces solo si cambia el ancho, es decir, al girar o redimensionar).
   */
  const userMoved = useRef(false);
  const lastSize = useRef({ w: 0, h: 0 });
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null);
  const [preferCanvas, setPreferCanvas] = useState(false);
  const fitToScreen = useCallback((animation = 0) => {
    const frame = frameRef.current, canvas = canvasRef.current, zoom = zoomRef.current;
    if (!frame || !canvas || !zoom) return;
    const fw = frame.clientWidth, fh = frame.clientHeight;
    if (fw < 40 || fh < 40) return;
    const cRect = canvas.getBoundingClientRect();
    const current = cRect.width / CANVAS_WIDTH || 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    canvas.querySelectorAll<HTMLElement>('[data-fit]').forEach((el) => {
      const r = el.getBoundingClientRect();
      minX = Math.min(minX, (r.left - cRect.left) / current);
      minY = Math.min(minY, (r.top - cRect.top) / current);
      maxX = Math.max(maxX, (r.right - cRect.left) / current);
      maxY = Math.max(maxY, (r.bottom - cRect.top) / current);
    });
    if (!Number.isFinite(minX)) [minX, minY, maxX, maxY] = [0, 0, CANVAS_WIDTH, CANVAS_HEIGHT];
    const pad = fw < 640 ? 12 : 32;
    const bw = maxX - minX, bh = maxY - minY;
    const scale = Math.min(1.6, Math.max(0.15, Math.min((fw - pad * 2) / bw, (fh - pad * 2) / bh)));
    zoom.setTransform(fw / 2 - (minX + bw / 2) * scale, fh / 2 - (minY + bh / 2) * scale, scale, animation);
    userMoved.current = false;
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      const w = frame.clientWidth, h = frame.clientHeight;
      setFrameSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      const widthChanged = Math.abs(w - lastSize.current.w) > 2;
      const heightChanged = Math.abs(h - lastSize.current.h) > 2;
      lastSize.current = { w, h };
      if (!widthChanged && !heightChanged) return;
      if (userMoved.current && !widthChanged) return; // p. ej. la barra del navegador del móvil al hacer scroll
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fitToScreen(200), 120);
    });
    ro.observe(frame);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [fitToScreen]);

  const isEditing = draft !== null;
  const current = draft ?? layout;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame) setFrameSize({ w: frame.clientWidth, h: frame.clientHeight });
  }, []);

  /*
   * En pantallas donde el esquema entero quedaría demasiado pequeño para leerse (móvil, tablet en vertical,
   * móvil en horizontal), se muestra en forma de lista: las mismas tarjetas, agrupadas por zonas y una debajo
   * de otra. Para editar el diseño, o si lo pides, vuelve el esquema con zoom.
   */
  const box = useMemo(() => contentBox(current), [current]);
  const readableScale = frameSize ? Math.min((frameSize.w - 24) / box.w, (frameSize.h - 24) / box.h) : 1;
  const smallScreen = readableScale < 0.7;
  const stacked = smallScreen && !isEditing && !preferCanvas;

  useEffect(() => {
    if (editingRequested && !draft) setDraft(structuredClone(layout));
    if (!editingRequested && draft) {
      setDraft(null);
      setConnectFrom(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRequested]);

  useEffect(() => {
    if (saveSignal > 0 && draft) void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSignal]);
  const nodesById = useMemo(() => new Map(current.nodes.map((n) => [n.id, n])), [current.nodes]);

  // Arrastre de nodos, zonas y esquinas de zona.
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = ((event.clientX - drag.startX) / rect.width) * 100;
      const dy = ((event.clientY - drag.startY) / rect.height) * 100;
      setDraft((d) => {
        if (!d) return d;
        if (drag.kind === 'node') {
          return { ...d, nodes: d.nodes.map((n) => (n.id === drag.id ? { ...n, x: snap(drag.originX + dx), y: snap(drag.originY + dy) } : n)) };
        }
        return {
          ...d,
          zones: d.zones.map((z) => {
            if (z.id !== drag.id) return z;
            if (drag.kind === 'zone') return { ...z, x: snap(drag.originX + dx), y: snap(drag.originY + dy) };
            return { ...z, width: Math.max(8, snap(drag.originX + dx)), height: Math.max(8, snap(drag.originY + dy)) };
          }),
        };
      });
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag]);

  const startDrag = (event: React.PointerEvent, id: string, kind: DragState['kind'], originX: number, originY: number) => {
    if (!isEditing || connectFrom !== undefined || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    setDrag({ id, kind, startX: event.clientX, startY: event.clientY, originX, originY });
  };

  function handleNodeClick(node: LayoutNode) {
    if (!isEditing) {
      if (node.serverId) onSelect(node.id);
      return;
    }
    if (connectFrom === undefined) return;
    if (connectFrom === null) {
      setConnectFrom(node.id);
      return;
    }
    if (connectFrom === node.id) {
      setConnectFrom(null);
      return;
    }
    setDraft((d) => {
      if (!d) return d;
      const exists = d.wires.some(
        (w) => (w.sourceId === connectFrom && w.targetId === node.id) || (w.sourceId === node.id && w.targetId === connectFrom),
      );
      return exists ? d : { ...d, wires: [...d.wires, { id: newId('w'), sourceId: connectFrom, targetId: node.id }] };
    });
    setConnectFrom(null);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await onSave(draft);
      setDraft(null);
      setConnectFrom(undefined);
      onEditingChange(false);
      toast('Esquema guardado');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo guardar el esquema', 'bad');
    } finally {
      setSaving(false);
    }
  }

  function wireTone(sourceId: string, targetId: string): { tone: Tone } {
    const target = servers.get(targetId) ?? servers.get(sourceId);
    if (!target || target.health === 'nodata') return { tone: 'ok' };
    return { tone: HEALTH_META[target.health].tone };
  }

  const hint =
    connectFrom === null
      ? 'Elige el nodo de origen de la conexión'
      : connectFrom
        ? `Elige el destino para ${nodesById.get(connectFrom)?.title ?? ''}`
        : null;

  return (
    <div ref={frameRef} className={cn('relative h-full w-full overflow-hidden', !isEditing && !stacked && 'cursor-grab active:cursor-grabbing')}>
      {stacked ? (
        <StackedSchema layout={current} servers={servers} now={now} onSelect={onSelect} onShowCanvas={() => setPreferCanvas(true)} />
      ) : (
      <TransformWrapper
        ref={zoomRef}
        initialScale={window.innerWidth < 768 ? 0.3 : 1}
        minScale={0.15}
        maxScale={3}
        centerOnInit
        onInit={() => requestAnimationFrame(() => fitToScreen(0))}
        onPanningStop={() => (userMoved.current = true)}
        onPinchingStop={() => (userMoved.current = true)}
        onWheelStop={() => (userMoved.current = true)}
        limitToBounds={false}
        wheel={{ step: 0.08 }}
        doubleClick={{ disabled: true }}
        panning={{ disabled: isEditing }}
      >
        {({ zoomIn, zoomOut }) => (
          <>
            {/* Barra de edición */}
            <div className="absolute top-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2">
              {isEditing && (
                <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface-2/95 p-1.5 shadow-xl shadow-black/40 backdrop-blur">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Plus size={14} aria-hidden />}
                    onClick={() =>
                      setEditing({
                        type: 'node',
                        isNew: true,
                        item: { id: newId('nodo'), x: 50, y: 50, title: '', icon: 'ServerIcon' },
                      })
                    }
                  >
                    Nodo
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<SquareDashed size={14} aria-hidden />}
                    onClick={() =>
                      setEditing({
                        type: 'zone',
                        isNew: true,
                        item: { id: newId('zona'), x: 35, y: 35, width: 30, height: 30, title: '', icon: 'Cloud', color: 'blue' },
                      })
                    }
                  >
                    Zona
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={connectFrom !== undefined}
                    icon={<Cable size={14} aria-hidden />}
                    className={cn(connectFrom !== undefined && 'bg-info/15 text-info hover:bg-info/20 hover:text-info')}
                    onClick={() => setConnectFrom((v) => (v === undefined ? null : undefined))}
                  >
                    Conectar
                  </Button>
                  <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Undo2 size={14} aria-hidden />}
                    onClick={() => onEditingChange(false)}
                  >
                    Descartar
                  </Button>
                  <Button size="sm" variant="primary" loading={saving} icon={<Save size={14} aria-hidden />} onClick={save}>
                    Guardar
                  </Button>
                </div>
              )}
              {hint && (
                <span role="status" className="rounded-lg border border-info/30 bg-info/10 px-3 py-1.5 text-xs text-info">
                  {hint}
                </span>
              )}
            </div>

            {/* Zoom */}
            <div className="absolute right-4 bottom-4 z-50 flex flex-col gap-2 md:right-8 md:bottom-8">
              {[
                { label: 'Acercar', icon: <ZoomIn size={20} />, run: () => ((userMoved.current = true), zoomIn()) },
                { label: 'Alejar', icon: <ZoomOut size={20} />, run: () => ((userMoved.current = true), zoomOut()) },
                { label: 'Ajustar a la pantalla', icon: <Maximize size={20} />, run: () => fitToScreen(300) },
                ...(smallScreen && !isEditing ? [{ label: 'Ver en lista', icon: <List size={20} />, run: () => setPreferCanvas(false) }] : []),
              ].map((b) => (
                <button
                  key={b.label}
                  type="button"
                  aria-label={b.label}
                  title={b.label}
                  onClick={b.run}
                  className="rounded-xl border border-white/10 bg-[#151619]/80 p-3 text-[#8e9299] shadow-lg backdrop-blur transition-all hover:border-white/30 hover:bg-white/10 hover:text-white"
                >
                  {b.icon}
                </button>
              ))}
            </div>

            <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }} contentStyle={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}>
              <div ref={canvasRef} className="relative" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}>
                {isEditing && (
                  <div className="pointer-events-none absolute inset-0 rounded-2xl border border-dashed border-info/25 bg-[linear-gradient(rgb(255_255_255/0.025)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.025)_1px,transparent_1px)] bg-[size:3.5%_6.125%]" />
                )}

                {/* Zonas */}
                {current.zones.map((zone) => {
                  const style = ZONE_STYLES[zone.color] ?? ZONE_STYLES.blue;
                  const Icon = nodeIcon(zone.icon);
                  return (
                    <div
                      key={zone.id}
                      data-fit
                      className={cn(
                        'absolute rounded-2xl border bg-gradient-to-b from-white/5 to-transparent transition-colors',
                        isEditing && connectFrom === undefined ? 'cursor-move border-white/30 hover:bg-white/10' : 'pointer-events-none border-white/10',
                      )}
                      style={{ left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.width}%`, height: `${zone.height}%` }}
                      onPointerDown={(e) => startDrag(e, zone.id, 'zone', zone.x, zone.y)}
                    >
                      <div className="absolute -top-3 left-6 flex items-center gap-2 rounded-full border border-white/10 bg-[#0a0a0c] px-3 py-1 text-[9px] font-bold tracking-widest text-[#8e9299] uppercase shadow-lg">
                        <Icon size={12} className={style.text} aria-hidden />
                        <span>{zone.title}</span>
                        {isEditing && (
                          <button
                            type="button"
                            aria-label={`Editar zona ${zone.title}`}
                            className="pointer-events-auto ml-1 rounded p-0.5 text-info hover:bg-info/15"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setEditing({ type: 'zone', item: zone, isNew: false })}
                          >
                            <Edit3 size={11} />
                          </button>
                        )}
                      </div>
                      {isEditing && connectFrom === undefined && (
                        <div
                          role="presentation"
                          className="absolute -right-1.5 -bottom-1.5 size-4 cursor-nwse-resize rounded-sm border border-info/60 bg-surface"
                          onPointerDown={(e) => startDrag(e, zone.id, 'resize', zone.width, zone.height)}
                        />
                      )}
                    </div>
                  );
                })}

                {/* Conexiones */}
                <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                  {current.wires.map((wire) => {
                    const source = nodesById.get(wire.sourceId);
                    const target = nodesById.get(wire.targetId);
                    if (!source || !target) return null;
                    const midY = source.y + (target.y - source.y) / 2;
                    const d = `M ${source.x} ${source.y} V ${midY} H ${target.x} V ${target.y}`;
                    const { tone } = wireTone(wire.sourceId, wire.targetId);
                    const color = CLASSIC_COLOR[tone];
                    return (
                      <g key={wire.id}>
                        <path d={d} fill="none" stroke={color} strokeOpacity={0.2} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                        <path
                          d={d}
                          fill="none"
                          stroke={color}
                          strokeWidth={2}
                          strokeDasharray="4 12"
                          vectorEffect="non-scaling-stroke"
                          className="animate-flow"
                          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
                        />
                      </g>
                    );
                  })}
                </svg>

                {/* Botones para quitar conexiones */}
                {isEditing &&
                  current.wires.map((wire) => {
                    const source = nodesById.get(wire.sourceId);
                    const target = nodesById.get(wire.targetId);
                    if (!source || !target) return null;
                    const midY = source.y + (target.y - source.y) / 2;
                    return (
                      <button
                        key={wire.id}
                        type="button"
                        aria-label={`Quitar conexión ${source.title} – ${target.title}`}
                        title="Quitar conexión"
                        className="absolute z-20 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-bad/40 bg-surface text-bad shadow-lg transition-colors hover:bg-bad/20"
                        style={{ left: `${(source.x + target.x) / 2}%`, top: `${midY}%` }}
                        onClick={() => setDraft((d) => (d ? { ...d, wires: d.wires.filter((w) => w.id !== wire.id) } : d))}
                      >
                        <Trash2 size={11} />
                      </button>
                    );
                  })}

                {/* Nodos */}
                {current.nodes.map((node) => (
                  <SchemaNode
                    key={node.id}
                    node={node}
                    server={servers.get(node.id) ?? null}
                    isEditing={isEditing}
                    isConnecting={connectFrom !== undefined}
                    isConnectSource={connectFrom === node.id}
                    now={now}
                    onPointerDown={(e) => startDrag(e, node.id, 'node', node.x, node.y)}
                    onClick={() => handleNodeClick(node)}
                    onEdit={() => setEditing({ type: 'node', item: node, isNew: false })}
                  />
                ))}
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
      )}

      {editing?.type === 'node' && (
        <NodeEditor
          node={editing.item}
          isNew={editing.isNew}
          knownServerIds={knownServerIds}
          endpoints={endpoints}
          onClose={() => setEditing(null)}
          onSave={(node) => {
            setDraft((d) =>
              d ? { ...d, nodes: editing.isNew ? [...d.nodes, node] : d.nodes.map((n) => (n.id === node.id ? node : n)) } : d,
            );
            setEditing(null);
          }}
          onDelete={() => {
            setDraft((d) =>
              d
                ? {
                    ...d,
                    nodes: d.nodes.filter((n) => n.id !== editing.item.id),
                    wires: d.wires.filter((w) => w.sourceId !== editing.item.id && w.targetId !== editing.item.id),
                  }
                : d,
            );
            setEditing(null);
          }}
        />
      )}
      {editing?.type === 'zone' && (
        <ZoneEditor
          zone={editing.item}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={(zone) => {
            setDraft((d) =>
              d ? { ...d, zones: editing.isNew ? [...d.zones, zone] : d.zones.map((z) => (z.id === zone.id ? zone : z)) } : d,
            );
            setEditing(null);
          }}
          onDelete={() => {
            setDraft((d) => (d ? { ...d, zones: d.zones.filter((z) => z.id !== editing.item.id) } : d));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function SchemaNode({
  node,
  server,
  isEditing,
  isConnecting,
  isConnectSource,
  onPointerDown,
  onClick,
  onEdit,
  inFlow = false,
}: {
  node: LayoutNode;
  server: ServerView | null;
  isEditing: boolean;
  isConnecting: boolean;
  isConnectSource: boolean;
  now: number;
  /** En la vista en lista: tarjeta en su sitio, sin posición absoluta. */
  inFlow?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onClick: () => void;
  onEdit: () => void;
}) {
  const Icon = nodeIcon(node.icon);
  const health = server?.health;
  // Sin servidor (WAN, router) o sin datos todavía: verde, como siempre.
  const tone: Tone = health && health !== 'nodata' ? HEALTH_META[health].tone : 'ok';
  const color = CLASSIC_COLOR[tone];
  const stats = server?.stats;
  const interactive = !isEditing ? Boolean(node.serverId) : isConnecting;

  const rows = stats
    ? [
        { label: 'CPU', value: stats.cpu, text: stats.cpu === null ? '—' : `${stats.cpu.toFixed(1)}%`, alert: (stats.cpu ?? 0) > THRESHOLDS.cpu },
        { label: 'RAM', value: stats.ram, text: stats.ram === null ? '—' : `${stats.ram.toFixed(1)}%`, alert: (stats.ram ?? 0) > THRESHOLDS.ram },
        ...(stats.appsTotal !== null
          ? [
              {
                label: 'Contenedores',
                value: stats.appsTotal === 0 ? 0 : ((stats.appsRunning ?? 0) / stats.appsTotal) * 100,
                text: `${stats.appsRunning ?? 0}/${stats.appsTotal}`,
                alert: (stats.appsRunning ?? 0) < stats.appsTotal,
              },
            ]
          : []),
      ]
    : [];

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `${node.title}${health ? `: ${HEALTH_META[health].label}` : ''}` : undefined}
      onPointerDown={isEditing && !isConnecting ? onPointerDown : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0c]/80 backdrop-blur-xl transition-all duration-300',
        inFlow ? 'relative w-full' : cn('absolute z-10 -translate-x-1/2 -translate-y-1/2', node.isGateway || !node.serverId ? 'w-40' : 'w-48'),
        !isEditing && interactive && 'cursor-pointer hover:z-20 hover:scale-105 hover:border-white/30 hover:shadow-[0_0_30px_rgba(0,0,0,0.8)]',
        isEditing && !isConnecting && 'cursor-move shadow-[0_0_20px_rgba(255,255,255,0.1)] ring-2 ring-white/30',
        isEditing && isConnecting && 'cursor-crosshair ring-2 ring-info/40 hover:ring-info',
        isConnectSource && 'ring-2 ring-info',
      )}
      data-fit={inFlow ? undefined : true}
      style={inFlow ? { boxShadow: '0 8px 32px rgba(0,0,0,0.4)' } : { left: `${node.x}%`, top: `${node.y}%`, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
    >
      {isEditing && !isConnecting && (
        <button
          type="button"
          aria-label={`Editar ${node.title}`}
          className="absolute top-2 right-2 z-50 rounded-md bg-blue-500/20 p-1.5 text-blue-400 transition-colors hover:bg-blue-500/40"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onEdit}
        >
          <Edit3 size={12} />
        </button>
      )}

      <div className="h-1 w-full opacity-80 transition-opacity group-hover:opacity-100" style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }} />

      <div className="p-3">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <div className="rounded-md border border-white/5 bg-white/5 p-1.5 transition-colors group-hover:bg-white/10">
              <Icon size={14} style={{ color }} aria-hidden />
            </div>
            <span className="truncate text-[11px] font-bold tracking-wider text-white uppercase">{node.title}</span>
          </div>
          {!isEditing && (
            <div className={cn('size-2 shrink-0 rounded-full', tone !== 'ok' && 'animate-pulse')} style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }} />
          )}
        </div>

        {node.subtitle && <div className={cn('truncate pr-6 pl-1 font-mono text-[10px] text-[#8e9299] uppercase', node.ip ? 'mb-1' : 'mb-3')}>{node.subtitle}</div>}

        {node.ip && (
          <div className="mb-3 pl-1">
            <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-blue-400/80">{node.ip}</span>
          </div>
        )}

        {rows.length > 0 && (
          <div className="mt-2 flex flex-col gap-2.5">
            {rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-1">
                <div className="flex justify-between px-1 font-mono text-[9px] uppercase">
                  <span className="text-[#8e9299]">{row.label}</span>
                  <span className={cn('tabular-nums', row.alert ? 'font-bold text-[#ffcc00]' : 'text-white')}>{row.text}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full border border-white/5 bg-black/60">
                  <div
                    className="relative h-full transition-all duration-500"
                    style={{ width: `${Math.max(0, Math.min(100, row.value ?? 0))}%`, backgroundColor: row.alert && tone !== 'bad' ? '#ffcc00' : color }}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/30" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Caja (en px del lienzo) que ocupan zonas y nodos, para saber a qué escala se vería el esquema entero. */
function contentBox(layout: Layout): { w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const z of layout.zones) {
    x0 = Math.min(x0, (z.x / 100) * CANVAS_WIDTH);
    y0 = Math.min(y0, (z.y / 100) * CANVAS_HEIGHT - 14);
    x1 = Math.max(x1, ((z.x + z.width) / 100) * CANVAS_WIDTH);
    y1 = Math.max(y1, ((z.y + z.height) / 100) * CANVAS_HEIGHT);
  }
  for (const n of layout.nodes) {
    const hw = (n.isGateway || !n.serverId ? 160 : 192) / 2, hh = (n.serverId ? 176 : 86) / 2;
    const cx = (n.x / 100) * CANVAS_WIDTH, cy = (n.y / 100) * CANVAS_HEIGHT;
    x0 = Math.min(x0, cx - hw); x1 = Math.max(x1, cx + hw); y0 = Math.min(y0, cy - hh); y1 = Math.max(y1, cy + hh);
  }
  return Number.isFinite(x0) ? { w: Math.max(200, x1 - x0), h: Math.max(150, y1 - y0) } : { w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
}

type Block = { kind: 'node'; key: string; y: number; x: number; node: LayoutNode } | { kind: 'zone'; key: string; y: number; x: number; zone: LayoutZone; nodes: LayoutNode[] };

/** Agrupa los nodos por la zona que los contiene y ordena zonas y nodos sueltos de arriba abajo, como en el esquema. */
function stackBlocks(layout: Layout): Block[] {
  const byPos = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y - b.y || a.x - b.x;
  const inZone = new Map<string, LayoutNode[]>();
  const loose: LayoutNode[] = [];
  for (const n of layout.nodes) {
    const zone = layout.zones
      .filter((z) => n.x >= z.x && n.x <= z.x + z.width && n.y >= z.y && n.y <= z.y + z.height)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (zone) inZone.set(zone.id, [...(inZone.get(zone.id) ?? []), n]);
    else loose.push(n);
  }
  const blocks: Block[] = [
    ...loose.map((node) => ({ kind: 'node' as const, key: node.id, y: node.y, x: node.x, node })),
    ...layout.zones
      .filter((zone) => inZone.has(zone.id))
      .map((zone) => ({ kind: 'zone' as const, key: zone.id, y: zone.y, x: zone.x, zone, nodes: inZone.get(zone.id)!.sort(byPos) })),
  ];
  return blocks.sort(byPos);
}

/** El esquema en forma de lista para pantallas pequeñas: mismas tarjetas y zonas, una debajo de otra. */
function StackedSchema({
  layout,
  servers,
  now,
  onSelect,
  onShowCanvas,
}: {
  layout: Layout;
  servers: Map<string, ServerView>;
  now: number;
  onSelect: (key: string) => void;
  onShowCanvas: () => void;
}) {
  const blocks = useMemo(() => stackBlocks(layout), [layout]);
  const noop = () => {};
  const card = (node: LayoutNode) => (
    <SchemaNode
      key={node.id}
      node={node}
      server={servers.get(node.id) ?? null}
      isEditing={false}
      isConnecting={false}
      isConnectSource={false}
      now={now}
      onPointerDown={noop}
      onClick={() => node.serverId && onSelect(node.id)}
      onEdit={noop}
      inFlow
    />
  );
  return (
    <div className="scrollbar-thin relative h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto flex max-w-2xl flex-col px-4 pt-6 pb-24">
        {blocks.map((b, i) => {
          const style = b.kind === 'zone' ? ZONE_STYLES[b.zone.color] ?? ZONE_STYLES.blue : null;
          const Icon = b.kind === 'zone' ? nodeIcon(b.zone.icon) : null;
          return (
            <Fragment key={b.key}>
              {i > 0 && <span aria-hidden className="mx-auto h-7 border-l-2 border-dashed border-[#00ff9d]/45" />}
              {b.kind === 'node' ? (
                <div className="mx-auto w-full max-w-[220px]">{card(b.node)}</div>
              ) : (
                <section aria-label={b.zone.title} className="relative rounded-2xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent px-3 pt-6 pb-3">
                  <div className="absolute -top-3 left-4 flex items-center gap-2 rounded-full border border-white/10 bg-[#0a0a0c] px-3 py-1 text-[9px] font-bold tracking-widest text-[#8e9299] uppercase shadow-lg">
                    {Icon && <Icon size={12} className={style!.text} aria-hidden />}
                    <span>{b.zone.title}</span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{b.nodes.map(card)}</div>
                </section>
              )}
            </Fragment>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onShowCanvas}
        aria-label="Ver el esquema completo"
        title="Ver el esquema completo"
        className="fixed right-4 bottom-4 z-40 rounded-xl border border-white/10 bg-[#151619]/90 p-3 text-[#8e9299] shadow-lg backdrop-blur transition-all hover:border-white/30 hover:bg-white/10 hover:text-white"
      >
        <Network size={20} aria-hidden />
      </button>
    </div>
  );
}
