import express from 'express';
import { DEFAULT_LAYOUT, DEFAULT_WIRES } from '../../shared/defaultLayout';
import type { Layout, LayoutNode, LayoutWire, LayoutZone, NodeIcon, ZoneColor } from '../../shared/types';
import type { DB } from '../db';

const ICONS: NodeIcon[] = ['Globe', 'Cloud', 'Router', 'ServerIcon', 'Cpu', 'Database', 'HardDrive', 'Shield'];
const COLORS: ZoneColor[] = ['purple', 'blue', 'green', 'amber'];
const MAX_ITEMS = 200;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const coordinate = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(200, Math.max(-100, n)) : fallback;
};
const asArray = (value: unknown) => (Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []);

function sanitizeNode(raw: any): LayoutNode | null {
  const id = text(raw?.id, 64);
  if (!id) return null;
  const node: LayoutNode = {
    id,
    x: coordinate(raw.x, 50),
    y: coordinate(raw.y, 50),
    title: text(raw.title, 40) || id,
    icon: ICONS.includes(raw.icon) ? raw.icon : 'ServerIcon',
  };
  const subtitle = text(raw.subtitle, 60);
  const ip = text(raw.ip, 60);
  const serverId = text(raw.serverId, 64);
  const endpoint = Number(raw.portainerEndpointId);
  if (subtitle) node.subtitle = subtitle;
  if (ip) node.ip = ip;
  if (serverId) node.serverId = serverId;
  if (Number.isInteger(endpoint) && endpoint > 0) node.portainerEndpointId = endpoint;
  if (raw.isGateway) node.isGateway = true;
  return node;
}

function sanitizeZone(raw: any): LayoutZone | null {
  const id = text(raw?.id, 64);
  if (!id) return null;
  return {
    id,
    x: coordinate(raw.x, 10),
    y: coordinate(raw.y, 10),
    width: Math.min(100, Math.max(5, coordinate(raw.width, 30))),
    height: Math.min(100, Math.max(5, coordinate(raw.height, 30))),
    title: text(raw.title, 60) || 'Zona',
    icon: ICONS.includes(raw.icon) ? raw.icon : 'Cloud',
    color: COLORS.includes(raw.color) ? raw.color : 'blue',
  };
}

function sanitizeLayout(body: any): Layout {
  const nodes = asArray(body?.nodes).map(sanitizeNode).filter((n): n is LayoutNode => n !== null);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const zones = asArray(body?.zones).map(sanitizeZone).filter((z): z is LayoutZone => z !== null);
  const wires = asArray(body?.wires)
    .map((raw: any): LayoutWire | null => {
      const sourceId = text(raw?.sourceId, 64);
      const targetId = text(raw?.targetId, 64);
      if (!nodeIds.has(sourceId) || !nodeIds.has(targetId) || sourceId === targetId) return null;
      return { id: text(raw?.id, 64) || `${sourceId}->${targetId}`, sourceId, targetId };
    })
    .filter((w): w is LayoutWire => w !== null);
  return { nodes, zones, wires };
}

export function createLayoutRouter(db: DB) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const row = db.prepare('SELECT nodes, zones, wires FROM layout ORDER BY id DESC LIMIT 1').get() as
      | { nodes: string; zones: string; wires: string | null }
      | undefined;
    if (!row) {
      res.json({ layout: DEFAULT_LAYOUT, saved: false });
      return;
    }
    try {
      const nodes = JSON.parse(row.nodes);
      const zones = JSON.parse(row.zones);
      // Los diseños guardados con la versión anterior no tienen conexiones: se usan las de siempre.
      const wires = row.wires ? JSON.parse(row.wires) : DEFAULT_WIRES;
      res.json({ layout: sanitizeLayout({ nodes, zones, wires }), saved: true });
    } catch (error) {
      console.error('[layout] Diseño guardado ilegible, se usa el inicial:', error);
      res.json({ layout: DEFAULT_LAYOUT, saved: false });
    }
  });

  const save: express.RequestHandler = (req, res) => {
    const layout = sanitizeLayout(req.body);
    db.prepare('INSERT INTO layout (nodes, zones, wires, saved_at) VALUES (?, ?, ?, ?)').run(
      JSON.stringify(layout.nodes),
      JSON.stringify(layout.zones),
      JSON.stringify(layout.wires),
      Date.now(),
    );
    res.json({ layout, saved: true });
  };
  router.put('/', save);
  router.post('/', save);

  return router;
}
