import { AppWindow, Globe, LockKeyhole, MonitorSmartphone, Package, Server, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
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
  const width = PAD * 2 + GAP * (nodes.length - 1);
  const height = 132;
  const x = (i: number) => PAD + i * GAP;
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
      const px = PAD + pos * GAP;
      packet.setAttribute('cx', String(px));
      glow.setAttribute('cx', String(px));
    };
    const ending = failIndex === -1 ? 'arrive' : 'cut';
    const endX = PAD + end * GAP;
    burst.setAttribute('cx', String(failIndex === -1 ? x(nodes.length - 1) : endX + 10));
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
        // Velocidad constante, con una pequeña pausa en cada nodo para que se vea pasar por él.
        const pos = (t / travel) * end;
        const whole = Math.floor(pos);
        const frac = pos - whole;
        const eased = whole + Math.min(1, frac * 1.15);
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
  }, [diagnosis, tracing, end, failIndex, nodes.length]);

  const packetColor = failIndex === -1 ? 'var(--color-ok)' : 'var(--color-bad)';

  return (
    <div className="scrollbar-thin overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        style={{ minWidth: Math.min(width, 640) }}
        role="img"
        aria-label={diagnosis ? `Ruta de la visita: ${diagnosis.title}` : 'Ruta de la visita, aún sin comprobar'}
      >
        {/* Enlaces entre pasos */}
        {nodes.slice(1).map((n, k) => {
          const i = k + 1;
          const x1 = x(i - 1) + R + 4;
          const x2 = x(i) - R - 4;
          if (failIndex !== -1 && i > failIndex) {
            return <line key={`l${i}`} x1={x1} y1={CY} x2={x2} y2={CY} stroke="var(--color-line-strong)" strokeWidth={2} strokeDasharray="3 5" />;
          }
          if (i === failIndex) {
            // El corte: el enlace se rompe antes de llegar.
            const mid = (x1 + x2) / 2;
            return (
              <g key={`l${i}`}>
                <line x1={x1} y1={CY} x2={mid - 7} y2={CY} stroke="var(--color-bad)" strokeWidth={2} strokeLinecap="round" />
                <line x1={mid + 7} y1={CY} x2={x2} y2={CY} stroke="var(--color-bad)" strokeOpacity={0.35} strokeWidth={2} strokeDasharray="3 5" />
                <path d={`M${mid - 5} ${CY - 9} L${mid + 5} ${CY + 9} M${mid + 5} ${CY - 9} L${mid - 5} ${CY + 9}`} stroke="var(--color-bad)" strokeWidth={2.5} strokeLinecap="round" />
              </g>
            );
          }
          const color = diagnosis ? (n.status === 'warn' ? 'var(--color-warn)' : 'var(--color-ok)') : 'var(--color-line-strong)';
          return <line key={`l${i}`} x1={x1} y1={CY} x2={x2} y2={CY} stroke={color} strokeOpacity={diagnosis ? 0.55 : 1} strokeWidth={2} strokeLinecap="round" />;
        })}

        {/* La visita viajando */}
        <circle ref={burstRef} cy={CY} r={0} fill="none" stroke={packetColor} strokeWidth={2} />
        <circle ref={glowRef} cy={CY} r={9} fill={packetColor} opacity={0} style={{ filter: 'blur(3px)' }} cx={PAD} />
        <circle ref={packetRef} cy={CY} r={5} fill={packetColor} stroke="var(--color-surface)" strokeWidth={2} cx={PAD} opacity={diagnosis && !tracing ? 1 : 0} />

        {/* Pasos */}
        {nodes.map((n, i) => {
          const Icon = ICONS[n.id];
          const after = failIndex !== -1 && i > failIndex;
          const isSel = selected === n.id;
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
              {/* Zona de clic más grande que el dibujo */}
              <rect x={x(i) - GAP / 2 + 6} y={4} width={GAP - 12} height={height - 8} fill="transparent" />
              {isSel && <circle cx={x(i)} cy={CY} r={R + 6} fill="none" stroke="var(--color-ink-3)" strokeWidth={1} strokeDasharray="2 3" />}
              {n.status === 'fail' && !REDUCED && (
                <circle cx={x(i)} cy={CY} r={R} fill="none" stroke="var(--color-bad)" strokeWidth={2} className="route-pulse" />
              )}
              <circle
                cx={x(i)}
                cy={CY}
                r={R}
                fill={n.status === 'fail' ? 'rgb(255 77 77 / 0.14)' : n.status === 'ok' ? 'rgb(0 255 157 / 0.08)' : n.status === 'warn' ? 'rgb(255 204 0 / 0.1)' : 'var(--color-surface-2)'}
                stroke={STROKE[n.status]}
                strokeOpacity={n.status === 'skip' ? 1 : 0.8}
                strokeWidth={n.status === 'fail' ? 2 : 1.5}
              />
              <Icon
                x={x(i) - 9}
                y={CY - 9}
                width={18}
                height={18}
                color={n.status === 'skip' ? 'var(--color-ink-3)' : STROKE[n.status]}
                strokeWidth={2}
                aria-hidden
              />
              <text x={x(i)} y={CY + R + 18} textAnchor="middle" className="fill-ink-3" style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {n.kind}
              </text>
              <text x={x(i)} y={CY + R + 34} textAnchor="middle" className={isSel ? 'fill-ink' : 'fill-ink-2'} style={{ fontSize: 12, fontWeight: 500 }}>
                {short(n.label)}
              </text>
              {n.status === 'fail' && (
                <text x={x(i)} y={CY + R + 50} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 600 }} className="fill-bad">
                  se corta aquí
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export type { NodeId };
