import { AppWindow, Globe, LockKeyhole, MonitorSmartphone, Package, Server, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useWidth } from '../../lib/hooks';
import type { Diagnosis, RouteStep, RouteStepId } from '../../../shared/types';
import { cn } from '../../lib/utils';

type NodeId = RouteStepId | 'visitor';
interface RouteNode {
  id: NodeId;
  kind: string;
  label: string;
  status: RouteStep['status'];
  detail: string;
}

const ICONS: Record<NodeId, typeof Globe> = {
  visitor: MonitorSmartphone,
  dns: Globe,
  server: Server,
  tls: LockKeyhole,
  proxy: Waypoints,
  container: Package,
  app: AppWindow,
};
const KIND: Record<NodeId, string> = {
  visitor: 'Visitante',
  dns: 'DNS',
  server: 'Servidor',
  tls: 'HTTPS',
  proxy: 'Proxy',
  container: 'Contenedor',
  app: 'Aplicación',
};
/** Pasos que se enseñan cuando aún no hay diagnóstico. */
const PLACEHOLDER: RouteStepId[] = ['dns', 'server', 'tls', 'proxy', 'container', 'app'];

const GAP = 128;
const PAD = 52;
const CY = 52;
const R = 22;
/** En vertical (móvil): separación entre pasos y columna de los círculos. */
const VGAP = 66;
const VPAD = 30;
const VX = 30;
const SEGMENT_MS = 520;
const PAUSE_MS = 1100;

const STROKE: Record<RouteStep['status'], string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  fail: 'var(--color-bad)',
  skip: 'var(--color-line-strong)',
};

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const short = (text: string, max = 16) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * La ruta de una visita, de izquierda a derecha. Un punto viaja desde el visitante y, si hay un corte,
 * se para en él: el enlace aparece roto en rojo y lo que hay detrás, apagado.
 */
export function RouteAnimation({
  diagnosis,
  tracing,
  selected,
  onSelect,
}: {
  diagnosis: Diagnosis | null;
  tracing: boolean;
  selected: NodeId | null;
  onSelect: (id: NodeId) => void;
}) {
  const nodes = useMemo<RouteNode[]>(() => {
    const steps: RouteNode[] = diagnosis
      ? diagnosis.steps.map((s) => ({ id: s.id, kind: KIND[s.id], label: s.label, status: s.status, detail: s.detail }))
      : PLACEHOLDER.map((id) => ({ id, kind: KIND[id], label: KIND[id], status: 'skip' as const, detail: '' }));
    return [{ id: 'visitor', kind: KIND.visitor, label: 'Tú / visitas', status: diagnosis ? 'ok' : 'skip', detail: 'Desde aquí sale la visita (el panel).' }, ...steps];
  }, [diagnosis]);

  const failIndex = nodes.findIndex((n) => n.status === 'fail');
  const [boxRef, boxWidth] = useWidth<HTMLDivElement>();
  // En pantallas estrechas la ruta va de arriba abajo, con la explicación de cada paso al lado.
  const vertical = boxWidth > 0 && boxWidth < 600;
  const width = vertical ? Math.max(280, boxWidth) : PAD * 2 + GAP * (nodes.length - 1);
  const height = vertical ? VPAD * 2 + VGAP * (nodes.length - 1) + 8 : 132;
  const at = (pos: number) => (vertical ? { x: VX, y: VPAD + pos * VGAP } : { x: PAD + pos * GAP, y: CY });
  /** Hasta dónde llega la visita: justo antes del corte, o hasta la aplicación. */
  const end = failIndex === -1 ? nodes.length - 1 : failIndex - 0.42;

  const packetRef = useRef<SVGCircleElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const burstRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const packet = packetRef.current;
    const glow = glowRef.current;
    const burst = burstRef.current;
    if (!packet || !glow || !burst) return;
    const place = (pos: number) => {
      const p = at(pos);
      for (const el of [packet, glow]) {
        el.setAttribute('cx', String(p.x));
        el.setAttribute('cy', String(p.y));
      }
    };
    const ending = failIndex === -1 ? 'arrive' : 'cut';
    const target = failIndex === -1 ? at(nodes.length - 1) : at(end + 0.08);
    burst.setAttribute('cx', String(target.x));
    burst.setAttribute('cy', String(target.y));
    if (REDUCED || !diagnosis || tracing) {
      place(diagnosis && !tracing ? end : 0);
      burst.setAttribute('r', '0');
      return;
    }
    const travel = Math.max(1, end) * SEGMENT_MS;
    let start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = now - start;
      if (t <= travel) {
        const pos = (t / travel) * end;
        const whole = Math.floor(pos);
        const eased = whole + Math.min(1, (pos - whole) * 1.15);
        place(Math.min(end, eased));
        packet.setAttribute('opacity', '1');
        glow.setAttribute('opacity', '0.35');
        burst.setAttribute('r', '0');
      } else if (t <= travel + PAUSE_MS) {
        const k = (t - travel) / PAUSE_MS;
        place(end);
        burst.setAttribute('r', String(6 + k * (ending === 'cut' ? 18 : 26)));
        burst.setAttribute('opacity', String(0.55 * (1 - k)));
        if (ending === 'cut') packet.setAttribute('opacity', String(1 - k));
      } else {
        start = now;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosis, tracing, end, failIndex, nodes.length, vertical, width]);

  const packetColor = failIndex === -1 ? 'var(--color-ok)' : 'var(--color-bad)';
  const start = at(0);

  /** Enlace entre dos pasos, recortado para no pisar los círculos. */
  const link = (i: number) => {
    const a = at(i - 1);
    const b = at(i);
    const len = vertical ? b.y - a.y : b.x - a.x;
    const from = R + 4;
    const to = len - R - 4;
    const p = (d: number) => (vertical ? { x: a.x, y: a.y + d } : { x: a.x + d, y: a.y });
    return { p, from, to, mid: (from + to) / 2 };
  };

  return (
    <div ref={boxRef} className={cn(!vertical && 'scrollbar-thin overflow-x-auto')}>
      {boxWidth > 0 && (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-auto w-full"
          style={vertical ? undefined : { minWidth: Math.min(width, 640) }}
          role="img"
          aria-label={diagnosis ? `Ruta de la visita: ${diagnosis.title}` : 'Ruta de la visita, aún sin comprobar'}
        >
          {/* Enlaces entre pasos */}
          {nodes.slice(1).map((n, k) => {
            const i = k + 1;
            const { p, from, to, mid } = link(i);
            const A = p(from);
            const B = p(to);
            if (failIndex !== -1 && i > failIndex) {
              return <line key={`l${i}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="var(--color-line-strong)" strokeWidth={2} strokeDasharray="3 5" />;
            }
            if (i === failIndex) {
              const M1 = p(mid - 7);
              const M2 = p(mid + 7);
              const C = p(mid);
              return (
                <g key={`l${i}`}>
                  <line x1={A.x} y1={A.y} x2={M1.x} y2={M1.y} stroke="var(--color-bad)" strokeWidth={2} strokeLinecap="round" />
                  <line x1={M2.x} y1={M2.y} x2={B.x} y2={B.y} stroke="var(--color-bad)" strokeOpacity={0.35} strokeWidth={2} strokeDasharray="3 5" />
                  <path d={`M${C.x - 5} ${C.y - 6} L${C.x + 5} ${C.y + 6} M${C.x + 5} ${C.y - 6} L${C.x - 5} ${C.y + 6}`} stroke="var(--color-bad)" strokeWidth={2.5} strokeLinecap="round" />
                </g>
              );
            }
            const color = diagnosis ? (n.status === 'warn' ? 'var(--color-warn)' : 'var(--color-ok)') : 'var(--color-line-strong)';
            return <line key={`l${i}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={color} strokeOpacity={diagnosis ? 0.55 : 1} strokeWidth={2} strokeLinecap="round" />;
          })}

          {/* La visita viajando */}
          <circle ref={burstRef} cx={start.x} cy={start.y} r={0} fill="none" stroke={packetColor} strokeWidth={2} />
          <circle ref={glowRef} cx={start.x} cy={start.y} r={9} fill={packetColor} opacity={0} style={{ filter: 'blur(3px)' }} />
          <circle ref={packetRef} cx={start.x} cy={start.y} r={5} fill={packetColor} stroke="var(--color-surface)" strokeWidth={2} opacity={diagnosis && !tracing ? 1 : 0} />

          {/* Pasos */}
          {nodes.map((n, i) => {
            const Icon = ICONS[n.id];
            const after = failIndex !== -1 && i > failIndex;
            const isSel = selected === n.id;
            const c = at(i);
            const textX = c.x + R + 14;
            const maxChars = Math.max(12, Math.floor((width - textX - 8) / 6.4));
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${n.kind}: ${n.label}. ${n.detail}`}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(n.id)}
                className={cn('cursor-pointer outline-none', after && 'opacity-45')}
              >
                <title>{`${n.kind} · ${n.label}${n.detail ? `\n${n.detail}` : ''}`}</title>
                {/* Zona de toque más grande que el dibujo */}
                {vertical ? (
                  <rect x={0} y={c.y - VGAP / 2 + 2} width={width} height={VGAP - 4} fill="transparent" />
                ) : (
                  <rect x={c.x - GAP / 2 + 6} y={4} width={GAP - 12} height={height - 8} fill="transparent" />
                )}
                {isSel && <circle cx={c.x} cy={c.y} r={R + 6} fill="none" stroke="var(--color-ink-3)" strokeWidth={1} strokeDasharray="2 3" />}
                {n.status === 'fail' && !REDUCED && <circle cx={c.x} cy={c.y} r={R} fill="none" stroke="var(--color-bad)" strokeWidth={2} className="route-pulse" />}
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={R}
                  fill={n.status === 'fail' ? 'rgb(255 77 77 / 0.14)' : n.status === 'ok' ? 'rgb(0 255 157 / 0.08)' : n.status === 'warn' ? 'rgb(255 204 0 / 0.1)' : 'var(--color-surface-2)'}
                  stroke={STROKE[n.status]}
                  strokeOpacity={n.status === 'skip' ? 1 : 0.8}
                  strokeWidth={n.status === 'fail' ? 2 : 1.5}
                />
                <Icon x={c.x - 9} y={c.y - 9} width={18} height={18} color={n.status === 'skip' ? 'var(--color-ink-3)' : STROKE[n.status]} strokeWidth={2} aria-hidden />
                {vertical ? (
                  <>
                    <text x={textX} y={c.y - 7} className="fill-ink-3" style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {n.kind}
                      {n.status === 'fail' ? ' · se corta aquí' : ''}
                    </text>
                    <text x={textX} y={c.y + 9} className={n.status === 'fail' ? 'fill-bad' : isSel ? 'fill-ink' : 'fill-ink-2'} style={{ fontSize: 13, fontWeight: 500 }}>
                      {short(n.label, maxChars)}
                    </text>
                    {n.detail && n.status !== 'skip' && (
                      <text x={textX} y={c.y + 24} className="fill-ink-3" style={{ fontSize: 11 }}>
                        {short(n.detail, Math.floor(maxChars * 1.12))}
                      </text>
                    )}
                  </>
                ) : (
                  <>
                    <text x={c.x} y={c.y + R + 18} textAnchor="middle" className="fill-ink-3" style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {n.kind}
                    </text>
                    <text x={c.x} y={c.y + R + 34} textAnchor="middle" className={isSel ? 'fill-ink' : 'fill-ink-2'} style={{ fontSize: 12, fontWeight: 500 }}>
                      {short(n.label)}
                    </text>
                    {n.status === 'fail' && (
                      <text x={c.x} y={c.y + R + 50} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 600 }} className="fill-bad">
                        se corta aquí
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export type { NodeId };
