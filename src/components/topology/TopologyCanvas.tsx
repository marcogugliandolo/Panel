import { Cable, Edit3, Maximize, Plus, Save, SquareDashed, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { THRESHOLDS, type Layout, type LayoutNode, type LayoutZone, type PortainerEndpoint } from '../../../shared/types';
import { formatPercent, timeAgo } from '../../lib/format';
import { nodeIcon } from '../../lib/icons';
import { HEALTH_META, TONE_COLOR, type ServerView, type Tone } from '../../lib/status';
import { cn } from '../../lib/utils';
import { Button, IconButton, Meter, StatusDot, useToast } from '../ui';
import { NodeEditor, ZoneEditor } from './LayoutEditors';

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
}

export function TopologyCanvas({ layout, servers, endpoints, knownServerIds, onSave, onSelect, now }: Props) {
  const [draft, setDraft] = useState<Layout | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null | undefined>(undefined); // undefined = modo conectar apagado
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // Escala para que el esquema quepa entero en pantalla al abrirlo (en el móvil, ~0,27).
  const fitScale = useMemo(
    () => Math.max(0.25, Math.min(1, (window.innerWidth - 24) / CANVAS_WIDTH, (window.innerHeight - 150) / CANVAS_HEIGHT)),
    [],
  );

  const isEditing = draft !== null;
  const current = draft ?? layout;
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
      toast('Esquema guardado');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo guardar el esquema', 'bad');
    } finally {
      setSaving(false);
    }
  }

  function wireTone(sourceId: string, targetId: string): { tone: Tone; animated: boolean } {
    const target = servers.get(targetId) ?? servers.get(sourceId);
    if (!target) return { tone: 'ok', animated: true };
    const tone = HEALTH_META[target.health].tone;
    return { tone, animated: target.health === 'online' || target.health === 'warning' };
  }

  const hint =
    connectFrom === null
      ? 'Elige el nodo de origen de la conexión'
      : connectFrom
        ? `Elige el destino para ${nodesById.get(connectFrom)?.title ?? ''}`
        : null;

  return (
    <div className={cn('relative h-full w-full overflow-hidden', !isEditing && 'cursor-grab active:cursor-grabbing')}>
      <TransformWrapper
        initialScale={fitScale}
        minScale={0.2}
        maxScale={3}
        centerOnInit
        limitToBounds={false}
        wheel={{ step: 0.08 }}
        doubleClick={{ disabled: true }}
        panning={{ disabled: isEditing }}
      >
        {({ zoomIn, zoomOut, centerView }) => (
          <>
            {/* Barra de edición */}
            <div className="absolute top-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2">
              {!isEditing ? (
                <Button size="sm" icon={<Edit3 size={14} aria-hidden />} onClick={() => setDraft(structuredClone(layout))}>
                  Editar esquema
                </Button>
              ) : (
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
                    onClick={() => {
                      setDraft(null);
                      setConnectFrom(undefined);
                    }}
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
            <div className="absolute right-3 bottom-3 z-30 flex flex-col gap-1 rounded-xl border border-line bg-surface-2/90 p-1 backdrop-blur md:right-5 md:bottom-5">
              <IconButton label="Acercar" onClick={() => zoomIn()}>
                <ZoomIn size={17} />
              </IconButton>
              <IconButton label="Alejar" onClick={() => zoomOut()}>
                <ZoomOut size={17} />
              </IconButton>
              <IconButton label="Ajustar a la pantalla" onClick={() => centerView(fitScale)}>
                <Maximize size={16} />
              </IconButton>
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
                      className={cn(
                        'absolute rounded-2xl border bg-gradient-to-b to-transparent',
                        style.border,
                        style.wash,
                        isEditing && connectFrom === undefined ? 'cursor-move hover:border-white/30' : 'pointer-events-none',
                      )}
                      style={{ left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.width}%`, height: `${zone.height}%` }}
                      onPointerDown={(e) => startDrag(e, zone.id, 'zone', zone.x, zone.y)}
                    >
                      <div className="absolute -top-3 left-5 flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 shadow-lg">
                        <Icon size={12} className={style.text} aria-hidden />
                        <span className="label-caps !text-[9px] !text-ink-2">{zone.title}</span>
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
                    const { tone, animated } = wireTone(wire.sourceId, wire.targetId);
                    const color = TONE_COLOR[tone];
                    return (
                      <g key={wire.id}>
                        <path d={d} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                        {animated && (
                          <path
                            d={d}
                            fill="none"
                            stroke={color}
                            strokeOpacity={0.85}
                            strokeWidth={2}
                            strokeDasharray="4 12"
                            vectorEffect="non-scaling-stroke"
                            className="animate-flow"
                          />
                        )}
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
  now,
  onPointerDown,
  onClick,
  onEdit,
}: {
  node: LayoutNode;
  server: ServerView | null;
  isEditing: boolean;
  isConnecting: boolean;
  isConnectSource: boolean;
  now: number;
  onPointerDown: (event: React.PointerEvent) => void;
  onClick: () => void;
  onEdit: () => void;
}) {
  const Icon = nodeIcon(node.icon);
  const health = server?.health;
  const tone: Tone = health ? HEALTH_META[health].tone : 'ok';
  const color = TONE_COLOR[tone];
  const stats = server?.stats;
  const interactive = !isEditing ? Boolean(node.serverId) : isConnecting;

  const metrics: { label: string; value: number | null; threshold: number }[] = stats
    ? [
        { label: 'CPU', value: stats.cpu, threshold: THRESHOLDS.cpu },
        { label: 'RAM', value: stats.ram, threshold: THRESHOLDS.ram },
        ...(stats.disk !== null ? [{ label: 'Disco', value: stats.disk, threshold: THRESHOLDS.disk }] : []),
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
        'absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-surface/90 shadow-[0_8px_32px_rgb(0_0_0/0.45)] backdrop-blur-xl transition-[border-color,box-shadow,transform] duration-200',
        node.isGateway || !node.serverId ? 'w-40' : 'w-44',
        isEditing && !isConnecting && 'cursor-move border-info/40',
        isEditing && isConnecting && 'cursor-crosshair border-info/40 hover:border-info',
        isConnectSource && 'border-info ring-2 ring-info/40',
        !isEditing && interactive && 'border-line hover:-translate-y-[calc(50%+2px)] hover:border-line-strong',
        !isEditing && !interactive && 'border-line',
      )}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
    >
      <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }} />
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-line bg-white/[0.04]">
              <Icon size={13} style={{ color: health ? color : 'var(--color-ink-2)' }} aria-hidden />
            </span>
            <span className="truncate text-[12px] font-semibold tracking-wide text-ink uppercase">{node.title}</span>
          </div>
          {isEditing ? (
            !isConnecting && (
              <button
                type="button"
                aria-label={`Editar ${node.title}`}
                className="rounded-md p-1 text-info hover:bg-info/15"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onEdit}
              >
                <Edit3 size={12} />
              </button>
            )
          ) : (
            health && <StatusDot tone={tone} pulse={health === 'offline' || health === 'warning'} />
          )}
        </div>

        {(node.subtitle || node.ip) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-0.5">
            {node.subtitle && <span className="truncate font-mono text-[10px] text-ink-3">{node.subtitle}</span>}
            {node.ip && (
              <span className="rounded border border-line bg-white/[0.03] px-1.5 py-px font-mono text-[9px] tracking-wide text-info/90">
                {node.ip}
              </span>
            )}
          </div>
        )}

        {node.serverId && (
          <div className="mt-3 space-y-2">
            {metrics.map((metric) => (
              <div key={metric.label} className="space-y-1">
                <div className="flex justify-between font-mono text-[9px] tracking-wider uppercase">
                  <span className="text-ink-3">{metric.label}</span>
                  <span className={cn('tabular-nums', metric.value !== null && metric.value > metric.threshold ? 'font-semibold text-warn' : 'text-ink')}>
                    {formatPercent(metric.value)}
                  </span>
                </div>
                <Meter value={stats?.online ? metric.value : null} threshold={metric.threshold} label={`${metric.label} de ${node.title}`} />
              </div>
            ))}
            {stats && stats.appsTotal !== null && (
              <div className="flex justify-between pt-0.5 font-mono text-[9px] tracking-wider uppercase">
                <span className="text-ink-3">Contenedores</span>
                <span className={cn('tabular-nums', health === 'warning' && server?.problems.some((p) => p.id === 'containers') ? 'font-semibold text-warn' : 'text-ink')}>
                  {stats.appsRunning ?? '—'}/{stats.appsTotal}
                </span>
              </div>
            )}
            {(!stats || !stats.online) && (
              <p className={cn('pt-0.5 font-mono text-[9px] tracking-wider uppercase', stats ? 'text-bad' : 'text-ink-3')}>
                {stats ? `Último dato ${timeAgo(stats.lastUpdated, now)}` : 'Esperando datos del script'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
