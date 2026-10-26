// @ts-nocheck — dibujo en canvas a mano (pixel art); el tipado estricto no aporta aquí.
/*
 * Motor de las vistas Oficina y Edificio.
 *
 * Cada servidor del esquema es un empleado en su mesa: teclea más rápido cuanta más CPU usa,
 * apila papeles según la RAM, su pantalla de pared muestra CPU/RAM/disco y su corcho tiene una
 * nota por contenedor. Si deja de enviar métricas, su silla se queda vacía. La recepción vigila
 * las webs (un teléfono por web) y tú, desde el despacho, llevas los encargos a cada mesa. En el CPD
 * están el router y el resto del equipo de red del esquema, y un rack con una luz por equipo de casa.
 *
 * Todo se dibuja en píxeles nativos (640×352) y se escala; nombres y bocadillos van en HTML encima.
 */
import { THRESHOLDS } from '../../../shared/types';
import { containerStateMeta, isContainerProblem } from '../../lib/status';
import type { OrderEvent } from '../../lib/orders';

export type SceneMode = 'oficina' | 'edificio';
export type FloorKey = 'atico' | 'nube' | 'casa' | 'baja';

export interface SceneServer {
  key: string;
  serverId: string;
  title: string;
  /** Planta donde va su mesa: nube (VPS) o casa. */
  floor: 'nube' | 'casa';
  online: boolean;
  hasData: boolean;
  cpu: number;
  ram: number;
  disk: number | null;
  containers: { name: string; state: string; status?: string | null; image?: string | null }[];
}

export interface SceneWeb {
  name: string;
  down: boolean;
  latencyMs: number | null;
}

/** Nodo del esquema que no es un servidor (router, firewall…): va al CPD. */
export interface SceneNetDevice {
  key: string;
  title: string;
  /** IP u otro dato corto que se enseña junto al nombre. */
  detail: string | null;
  kind: 'router' | 'firewall' | 'box';
}
const DEFAULT_ROUTER: SceneNetDevice = { key: 'router', title: 'Router', detail: null, kind: 'router' };

export interface SceneOptions {
  canvas: HTMLCanvasElement;
  world: HTMLElement;
  stageScroll: HTMLElement;
  overlays: Record<SceneMode, HTMLElement>;
  onSelect: (key: string) => void;
  onFloor: (floor: FloorKey) => void;
}

/* ---------- Medidas ---------- */
const T = 16, MW = 40, MH = 22, W = MW * T, H = MH * T;
const DESK_Y = 66;
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const RECEPTION_KEY = 'reception';

const C = {
  void: '#07080a', wall: '#2c2f39', wallHi: '#363a45', wallLo: '#23252d', cap: '#3b3f4b', face: '#272a33', faceLine: '#23262e', base: '#1b1d23',
  hall: '#1b1d23', hall2: '#1d1f26', hallLine: '#202329',
  nube: '#1d1a2b', nubeDot: '#262039', casa: '#171f2c', casaDot: '#1d283a', office: '#2a2019', officeSeam: '#211912',
  deskTop: '#6e4b31', deskHi: '#8a603f', deskFront: '#4d3322', deskDark: '#33221a',
  chair: '#2a2d36', chairHi: '#383c48', outline: '#0b0b0f',
  cable: '#22252e', cableHi: '#2e323d',
  ok: '#00ff9d', warn: '#ffcc00', bad: '#ff4d4d', info: '#5a9cf0',
  paper: '#e8e4da', paperShade: '#c4beaf', mug: '#d8d4cc', coffee: '#5a3a22',
  leaf: '#2f7a4d', leaf2: '#3d9661', pot: '#8a5a3c', potHi: '#a06a48', cork: '#8c6744', corkFrame: '#5b412b',
  screenFrame: '#0c0d11', screenTrack: '#132520',
  monitor: '#1c1e25', monitorHi: '#30333d', keyboard: '#3a3d47', keyboardHi: '#4d515d',
  lampHead: '#d6cfb2', lampOff: '#4a4c52', lampArm: '#555a66',
  counterTop: '#4b505e', counterFront: '#30343f', shoes: '#121318', slab: '#2f323c', slabHi: '#40444f',
  cpd: '#1f232b', cpdLine: '#171a20', cpdHi: '#262b34', cpdVent: '#12151a',
  rack: '#121419', rackTop: '#3a3e4a', rackFrame: '#2a2d36', rackUnit: '#1d2027',
};

/* ---------- Utilidades ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pct = (v) => `${Math.round(v)} %`;
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round((n >> 16) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
function rect(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
/** Piezas [x,y,w,h,color,contorno?] con un contorno común de 1 px. */
function spr(g, parts) {
  g.fillStyle = C.outline;
  for (const p of parts) if (p[5] !== false) g.fillRect(p[0] - 1, p[1] - 1, p[2] + 2, p[3] + 2);
  for (const p of parts) { g.fillStyle = p[4]; g.fillRect(p[0], p[1], p[2], p[3]); }
}
function glow(g, x, y, r, rgb, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
}
function makePrng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function hash(s) { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

/* ---------- Aspecto de cada empleado (estable por servidor) ---------- */
function look(o) { return { pants: '#262a33', ...o, shirtD: shade(o.shirt, 0.72), skinD: shade(o.skin, 0.8) }; }
const KNOWN_LOOKS = {
  'vps-contabo': { shirt: '#7c6cf0', hair: '#3a2418', skin: '#f0c39b', style: 'short' },
  'vps-oracle': { shirt: '#3fa7c9', hair: '#16161a', skin: '#c98e62', style: 'bun' },
  'proxmox-node': { shirt: '#e08a3c', hair: '#b5651d', skin: '#f3cfae', style: 'spiky' },
  'rpi-1': { shirt: '#c24d78', hair: '#e2c76f', skin: '#e9b48a', style: 'long' },
  'rpi-2': { shirt: '#6b7fa6', hair: '#9aa0aa', skin: '#d9a37b', style: 'beard' },
};
const SHIRTS = ['#7c6cf0', '#3fa7c9', '#e08a3c', '#c24d78', '#6b7fa6', '#8a6bbf', '#4f8fbf', '#b0607e'];
const HAIRS = ['#3a2418', '#16161a', '#b5651d', '#e2c76f', '#9aa0aa', '#5a2e1e'];
const SKINS = ['#f0c39b', '#c98e62', '#f3cfae', '#e9b48a', '#d9a37b', '#a8724e'];
const STYLES = ['short', 'bun', 'spiky', 'long', 'beard'];
export function lookFor(serverId) {
  if (serverId === RECEPTION_KEY) return look({ shirt: '#9a7b5f', hair: '#5a2e1e', skin: '#e6b08a', style: 'long' });
  if (KNOWN_LOOKS[serverId]) return look(KNOWN_LOOKS[serverId]);
  const h = hash(serverId);
  return look({ shirt: SHIRTS[h % SHIRTS.length], hair: HAIRS[(h >> 3) % HAIRS.length], skin: SKINS[(h >> 6) % SKINS.length], style: STYLES[(h >> 9) % STYLES.length] });
}
const BOSS_LOOK = look({ shirt: '#dfe2e8', hair: '#2a1a12', skin: '#e3b089', style: 'short', pants: '#2b2f3a', tie: true });

/* ---------- Personajes ---------- */
function hair(p, cx, ht, L) {
  const h = L.hair;
  switch (L.style) {
    case 'bun': p.push([cx - 4, ht - 1, 8, 3, h], [cx - 2, ht - 4, 4, 3, h], [cx - 4, ht + 2, 1, 2, h], [cx + 3, ht + 2, 1, 2, h]); break;
    case 'long': p.push([cx - 4, ht - 1, 8, 3, h], [cx - 5, ht, 2, 9, h], [cx + 3, ht, 2, 9, h]); break;
    case 'spiky': p.push([cx - 4, ht - 1, 8, 2, h], [cx - 3, ht - 3, 1, 2, h], [cx - 1, ht - 3, 2, 2, h], [cx + 2, ht - 3, 1, 2, h], [cx - 4, ht + 1, 1, 2, h], [cx + 3, ht + 1, 1, 2, h]); break;
    case 'beard': p.push([cx - 4, ht - 1, 8, 2, h], [cx - 4, ht + 1, 1, 2, h], [cx + 3, ht + 1, 1, 2, h], [cx - 4, ht + 4, 8, 3, h]); break;
    default: p.push([cx - 4, ht - 1, 8, 3, h], [cx - 4, ht + 2, 1, 2, h], [cx + 3, ht + 2, 1, 2, h]);
  }
}
function face(p, cx, ht, L, blink, talk) {
  const e = '#1a1420';
  if (blink) p.push([cx - 2, ht + 3, 1, 1, e, false], [cx + 1, ht + 3, 1, 1, e, false]);
  else p.push([cx - 2, ht + 2, 1, 2, e, false], [cx + 1, ht + 2, 1, 2, e, false]);
  if (L.style !== 'beard') p.push(talk ? [cx - 1, ht + 5, 2, 1, '#7a3a2e', false] : [cx - 1, ht + 5, 2, 1, L.skinD, false]);
}
function drawSeated(g, cx, ty, L, o) {
  const p = [], b = o.bob || 0, ht = ty - 18 + b;
  p.push([cx - 5, ty - 10 + b, 10, 11 - b, L.shirt]);
  p.push([cx - 7, ty - 9 + b, 2, 9 - b, L.shirt], [cx + 5, ty - 9 + b, 2, 9 - b, L.shirt]);
  p.push([cx - 1, ty - 11 + b, 2, 1, L.skinD]);
  p.push([cx - 4, ht, 8, 7, L.skin]);
  hair(p, cx, ht, L);
  p.push([cx + 3, ty - 9 + b, 2, 9, L.shirtD, false], [cx - 2, ty - 10 + b, 4, 1, L.skinD, false]);
  if (L.tie) p.push([cx, ty - 9 + b, 1, 6, C.ok, false]);
  face(p, cx, ht, L, o.blink, o.talk);
  if (o.sip) p.push([cx - 5, ht + 4, 4, 4, C.mug], [cx - 6, ht + 6, 2, 2, L.skin]);
  spr(g, p);
  if (o.sweat) rect(g, cx + 4, ht + 1 + o.sweatY, 1, 2, '#8fd0ff');
}
function drawHands(g, cx, ty, L, lo, ro, sip) {
  const p = [];
  if (!sip) p.push([cx - 7, ty, 2, 4, L.shirt], [cx - 6, ty + 3 + lo, 3, 2, L.skin]);
  p.push([cx + 5, ty, 2, 4, L.shirt], [cx + 3, ty + 3 + ro, 3, 2, L.skin]);
  spr(g, p);
}
function drawWalker(g, x, y, L, dir, moving, frame, carrying) {
  rect(g, x - 4, y - 1, 9, 2, 'rgba(0,0,0,.35)');
  const p = [], ht = y - 19;
  if (dir === 'down' || dir === 'up') {
    const la = moving && frame ? 1 : 0, ra = moving && !frame ? 1 : 0;
    p.push([x - 3, y - 6, 2, 5 - la, L.pants], [x + 1, y - 6, 2, 5 - ra, L.pants]);
    p.push([x - 3, y - 1 - la, 2, 1, C.shoes, false], [x + 1, y - 1 - ra, 2, 1, C.shoes, false]);
    p.push([x - 4, y - 12, 8, 7, L.shirt]);
    p.push([x - 5, y - 12 + ra, 1, 5, L.shirt], [x + 4, y - 12 + la, 1, 5, L.shirt]);
    p.push([x - 4, ht, 8, 7, L.skin]);
    if (dir === 'down') {
      hair(p, x, ht, L);
      if (L.tie) p.push([x, y - 11, 1, 4, C.ok, false]);
      face(p, x, ht, L, false, false);
      if (carrying) p.push([x + 2, y - 10, 5, 6, '#e9d8a6']);
    } else {
      p.push([x - 4, ht - 1, 8, 7, L.hair]);
      if (carrying) p.push([x - 7, y - 10, 3, 5, '#e9d8a6']);
    }
  } else {
    const f = dir === 'right' ? 1 : -1, s = moving ? (frame ? 1 : -1) : 0;
    p.push([x - 2 + s, y - 6, 2, 5, L.pants], [x - s, y - 6, 2, 5, L.pants]);
    p.push([x - 3, y - 12, 6, 7, L.shirt]);
    p.push([x - 4, ht, 8, 7, L.skin], [x - 4, ht - 1, 8, 3, L.hair]);
    p.push(f > 0 ? [x - 4, ht + 2, 3, 3, L.hair] : [x + 1, ht + 2, 3, 3, L.hair]);
    p.push(f > 0 ? [x + 2, ht + 2, 1, 2, '#1a1420', false] : [x - 3, ht + 2, 1, 2, '#1a1420', false]);
    p.push([x - 1 + s * f, y - 11, 2, 5, L.shirtD]);
    if (carrying) p.push([x + (f > 0 ? 3 : -7), y - 10, 4, 5, '#e9d8a6']);
  }
  spr(g, p);
}
/** Retrato para la plantilla (22×20 px, se muestra a doble tamaño). */
export function paintPortrait(cv, L) {
  const g = cv.getContext('2d'), cx = 11, ht = 5, p = [];
  rect(g, 0, 0, 22, 20, '#16181e');
  p.push([cx - 6, 13, 12, 8, L.shirt], [cx - 1, 12, 2, 1, L.skinD], [cx - 4, ht, 8, 7, L.skin]);
  hair(p, cx, ht, L);
  p.push([cx + 3, 14, 3, 6, L.shirtD, false]);
  face(p, cx, ht, L, false, false);
  spr(g, p);
}

/* ---------- Muebles ---------- */
function plant(g, x, y) {
  spr(g, [[x - 6, y - 15, 5, 6, C.leaf], [x + 1, y - 16, 5, 7, C.leaf], [x - 3, y - 20, 6, 7, C.leaf2], [x - 4, y - 6, 8, 6, C.pot], [x - 5, y - 8, 10, 2, C.potHi]]);
}
function nightWindow(g, wx, wy, w, h, seed) {
  spr(g, [[wx, wy, w, h, '#0d1424']]);
  const r = makePrng(seed);
  for (let i = 0; i < w / 5; i++) rect(g, wx + Math.floor(r() * w), wy + Math.floor(r() * (h - 2)), 1, 1, '#c9d6ff');
  for (let x = wx + 15; x < wx + w - 2; x += 16) rect(g, x, wy, 2, h, '#1a1f2c');
  rect(g, wx, wy + Math.floor(h / 2) - 1, w, 2, '#1a1f2c');
}
function bookshelf(g, x, y, seed) {
  spr(g, [[x, y, 28, 28, '#3d2b1f']]);
  const r = makePrng(seed), books = ['#7c6cf0', '#3fa7c9', '#c24d78', '#e08a3c', '#6b7fa6', '#9aa0aa', '#2f7a4d'];
  for (const sy of [y + 3, y + 12, y + 21]) {
    rect(g, x + 2, sy, 24, 7, '#251a12');
    for (let bx = x + 3; bx < x + 24;) { const bw = 2 + Math.floor(r() * 2), bh = 5 + Math.floor(r() * 2); rect(g, bx, sy + 7 - bh, bw, bh, books[Math.floor(r() * books.length)]); bx += bw + 1; }
  }
}
function drawLogo(g, x, y) {
  spr(g, [[x, y, 16, 16, '#00c97c']]);
  for (const [px, py] of [[2, 8], [4, 8], [5, 6], [6, 4], [7, 10], [8, 12], [9, 8], [11, 8], [12, 8]]) rect(g, x + px, y + py, 1, 1, '#04140d');
}
function drawDesk(g, cx, ty, w, top = C.deskTop, hi = C.deskHi, front = C.deskFront) {
  const x = cx - w / 2;
  rect(g, x + 2, ty + 22, w - 2, 3, 'rgba(0,0,0,.35)');
  spr(g, [[x, ty, w, 14, top], [x, ty + 14, w, 8, front], [x, ty, w, 1, hi, false], [cx - 5, ty + 17, 10, 1, C.deskDark, false]]);
}
function drawPapers(g, x, yb, n, messy) {
  const h = n * 2;
  spr(g, [[x, yb - h, 8, h, C.paper]]);
  for (let i = 1; i < n; i++) rect(g, x, yb - h + i * 2, 8, 1, C.paperShade);
  if (messy) spr(g, [[x + 3, yb - h - 3, 7, 2, C.paper]]);
}
function drawCables(g, paths) {
  for (const P of paths) for (let i = 1; i < P.pts.length; i++) {
    const [x1, y1] = P.pts[i - 1], [x2, y2] = P.pts[i];
    if (y1 === y2) { const a = Math.min(x1, x2), b = Math.max(x1, x2); rect(g, a - 1, y1 - 1, b - a + 3, 3, C.cable); rect(g, a - 1, y1 - 1, b - a + 3, 1, C.cableHi); }
    else { const a = Math.min(y1, y2), b = Math.max(y1, y2); rect(g, x1 - 1, a - 1, 3, b - a + 3, C.cable); rect(g, x1 - 1, a - 1, 1, b - a + 3, C.cableHi); }
  }
}
function brackets(g, x, y, w, h, col) {
  const l = 5;
  rect(g, x, y, l, 1, col); rect(g, x, y, 1, l, col); rect(g, x + w - l, y, l, 1, col); rect(g, x + w - 1, y, 1, l, col);
  rect(g, x, y + h - 1, l, 1, col); rect(g, x, y + h - l, 1, l, col); rect(g, x + w - l, y + h - 1, l, 1, col); rect(g, x + w - 1, y + h - l, 1, l, col);
}

/* ---------- Plantas del edificio y plano de la oficina ---------- */
export const FLOORS = [
  { key: 'atico', label: 'Ático', name: 'Despacho', y0: 46, room: [16, 176, 224, 160] },
  { key: 'nube', label: 'Planta 2', name: 'Nube', y0: 116, room: [16, 32, 224, 144] },
  { key: 'casa', label: 'Planta 1', name: 'Casa y CPD', y0: 186, room: [400, 32, 224, 304] },
  { key: 'baja', label: 'Planta baja', name: 'Recepción', y0: 256, room: [256, 32, 128, 304] },
];
const FI = Object.fromEntries(FLOORS.map((f, i) => [f.key, i]));
/** Mesas disponibles: cx en el plano de la oficina, bx en el corte del edificio. */
const SLOTS = {
  nube: [{ cx: 72, bx: 196 }, { cx: 184, bx: 300 }],
  casa: [{ cx: 440, bx: 176 }, { cx: 512, bx: 266 }, { cx: 584, bx: 356 }],
};

const tiles = Array.from({ length: MH }, () => new Array(MW).fill('wall'));
function area(x0, y0, x1, y1, t) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles[y][x] = t; }
// Casa arriba a la derecha y, debajo, el CPD con el router y los racks.
area(1, 2, 14, 10, 'nube'); area(1, 12, 14, 20, 'office'); area(16, 2, 23, 20, 'hall'); area(25, 2, 38, 11, 'casa'); area(25, 13, 38, 20, 'cpd');
for (const [x, y] of [[15, 5], [15, 6], [15, 15], [15, 16], [24, 9], [24, 10], [24, 16], [24, 17]]) tiles[y][x] = 'door';
function baseBlocked() {
  const b = tiles.map((r) => r.map((t) => t === 'wall'));
  const block = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) b[y][x] = true; };
  block(18, 8, 21, 10); block(5, 15, 9, 16); block(5, 7, 8, 9);
  block(1, 12, 2, 12); block(13, 12, 13, 12); block(13, 20, 13, 20); block(1, 3, 1, 3); block(14, 3, 14, 3);
  block(16, 2, 16, 2); block(23, 2, 23, 2); block(16, 20, 17, 20); block(23, 19, 23, 20);
  block(25, 3, 25, 3); block(38, 11, 38, 11); block(33, 10, 36, 11);
  block(25, 13, 38, 20); // en el CPD no hay que entrar para hacer encargos
  return { b, block };
}

/* ---------- CPD: el router (y el resto del equipo de red del esquema) y los racks ---------- */
/** Dónde va cada aparato de red en el plano: el primero recibe los cables de casa. */
const NET_X = [456, 528, 592];
const ROUTER_PT = [456, 272];
const RACK_X = [444, 472, 500];
const CPD_B = { x: 400, rackX: 404, devX: 452 }; // en el corte del edificio, a la derecha de la planta 1

function mkPath(pts, routerPt) {
  let len = 0, dR = -1; const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    segs.push(l); len += l;
    if (routerPt && pts[i][0] === routerPt[0] && pts[i][1] === routerPt[1]) dR = len;
  }
  return { pts, segs, len, dRouter: dR };
}
function officePath(floor, cx) {
  if (floor === 'nube') return mkPath([[320, 34], [320, 104], [cx, 104], [cx, 90]]);
  // Baja por el pasillo, entra al CPD, pasa por el router y sube por la pared hasta cada mesa.
  return mkPath([[320, 34], [320, 56], [368, 56], [368, ROUTER_PT[1]], ROUTER_PT, [ROUTER_PT[0], 128], [cx, 128], [cx, 90]], ROUTER_PT);
}
function buildingPath(floor, bx) {
  const roof = [[496, 4], [496, 30], [477, 30]];
  if (floor === 'nube') return mkPath([...roof, [477, 118], [bx, 118]]);
  return mkPath([...roof, [477, 188], [CPD_B.devX, 188], [bx, 188]], [CPD_B.devX, 188]);
}
function pointAt(P, d) {
  for (let i = 0; i < P.segs.length; i++) {
    if (d <= P.segs[i]) { const a = P.pts[i], b = P.pts[i + 1], t = P.segs[i] ? d / P.segs[i] : 0; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    d -= P.segs[i];
  }
  return P.pts[P.pts.length - 1];
}

function drawOfficeBG(paths) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  rect(g, 0, 0, W, H, C.void);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const t = tiles[y][x], px = x * T, py = y * T;
    if (t === 'hall' || t === 'door') { rect(g, px, py, T, T, (x + y) % 2 ? C.hall : C.hall2); rect(g, px, py, T, 1, C.hallLine); rect(g, px, py, 1, T, C.hallLine); }
    else if (t === 'nube') { rect(g, px, py, T, T, C.nube); for (let yy = 2; yy < T; yy += 4) for (let xx = 2; xx < T; xx += 4) rect(g, px + xx, py + yy, 1, 1, C.nubeDot); }
    else if (t === 'casa') { rect(g, px, py, T, T, C.casa); for (let yy = 0; yy < T; yy++) for (let xx = 0; xx < T; xx++) if ((px + xx + py + yy) % 8 === 0) rect(g, px + xx, py + yy, 1, 1, C.casaDot); }
    else if (t === 'office') rect(g, px, py, T, T, C.office);
    else if (t === 'cpd') {
      // Suelo técnico: baldosas con junta y, en el pasillo frío delante de los racks, rejilla perforada.
      rect(g, px, py, T, T, C.cpd); rect(g, px, py, T, 1, C.cpdLine); rect(g, px, py, 1, T, C.cpdLine); rect(g, px + 1, py + 1, T - 1, 1, C.cpdHi);
      if (y === 17 && x >= 27 && x <= 33) for (let yy = 4; yy < T - 2; yy += 3) for (let xx = 4; xx < T - 2; xx += 3) rect(g, px + xx, py + yy, 1, 1, C.cpdVent);
    }
    else { rect(g, px, py, T, T, C.wall); rect(g, px, py, 1, T, C.wallHi); rect(g, px + T - 1, py, 1, T, C.wallLo); }
  }
  for (let y = 192; y < 336; y++) if (y % 5 === 0) rect(g, 16, y, 224, 1, C.officeSeam);
  for (let r = Math.floor(192 / 5); r * 5 < 336; r++) for (let x = 16 + ((r * 13) % 36); x < 240; x += 36) rect(g, x, r * 5 + 1, 1, 4, C.officeSeam);
  rect(g, 0, 0, W, 4, C.cap); rect(g, 0, 4, W, 26, C.face); rect(g, 0, 30, W, 2, C.base);
  for (let x = 0; x < W; x += 32) rect(g, x, 4, 1, 26, C.faceLine);
  rect(g, 16, 176, 224, 4, C.cap); rect(g, 16, 180, 224, 10, C.face); rect(g, 16, 190, 224, 2, C.base);
  rect(g, 0, 32, W, 2, 'rgba(0,0,0,.35)'); rect(g, 0, 34, W, 2, 'rgba(0,0,0,.16)');
  rect(g, 16, 192, 224, 2, 'rgba(0,0,0,.35)');
  // Pared norte del CPD, con el aire acondicionado y el paso de cables hacia las mesas de casa.
  rect(g, 400, 192, 224, 4, C.cap); rect(g, 400, 196, 224, 10, C.face); rect(g, 400, 206, 224, 2, C.base);
  rect(g, 400, 208, 224, 2, 'rgba(0,0,0,.35)'); rect(g, 400, 210, 224, 2, 'rgba(0,0,0,.16)');
  spr(g, [[566, 194, 44, 11, '#c9ccd3']]); rect(g, 566, 194, 44, 1, '#e4e6ea');
  for (const y of [200, 202]) rect(g, 569, y, 38, 1, '#8a8f99');
  rect(g, 604, 196, 2, 1, C.ok);
  spr(g, [[ROUTER_PT[0] - 4, 194, 8, 12, '#3a3e4a']]); rect(g, ROUTER_PT[0] - 3, 195, 6, 1, '#4a4f5c');
  for (const [x, y0] of [[15, 5], [15, 15], [24, 9], [24, 16]]) { rect(g, x * T, y0 * T - 2, T, 2, C.cap); rect(g, x * T, (y0 + 2) * T, T, 2, C.cap); }
  spr(g, [[302, 5, 36, 26, '#0e1015']]);
  rect(g, 304, 8, 15, 22, '#13233a'); rect(g, 321, 8, 15, 22, '#13233a');
  rect(g, 305, 9, 2, 20, '#1d3555'); rect(g, 322, 9, 2, 20, '#1d3555');
  rect(g, 316, 18, 2, 4, '#5a6170'); rect(g, 322, 18, 2, 4, '#5a6170');
  rect(g, 304, 33, 32, 6, '#24272f');
  nightWindow(g, 112, 8, 32, 18, 3); nightWindow(g, 262, 8, 32, 18, 9);
  drawLogo(g, 346, 9);
  spr(g, [[178, 181, 24, 8, '#151821']]);
  rect(g, 182, 183, 3, 2, C.info); rect(g, 189, 183, 3, 2, C.info); rect(g, 196, 183, 3, 2, C.info); rect(g, 183, 185, 14, 1, '#2d4a72');
  spr(g, [[84, 222, 72, 58, '#2b2033']]); rect(g, 87, 225, 66, 52, '#33263d'); rect(g, 90, 228, 60, 46, '#2b2033');
  drawCables(g, paths);
  // Extintor junto a la puerta del CPD y bandeja de cables a lo largo de la pared.
  spr(g, [[405, 300, 7, 15, '#c43c3c'], [406, 297, 5, 3, '#2a2d36']]); rect(g, 406, 302, 1, 10, '#e0605c'); rect(g, 405, 305, 7, 2, '#e8e4da');
  rect(g, 404, 316, 9, 2, 'rgba(0,0,0,.3)');
  spr(g, [[94, 125, 8, 6, C.chair], [122, 125, 8, 6, C.chair]]);
  spr(g, [[86, 132, 52, 12, '#5c4030'], [86, 144, 52, 6, '#3f2b1f']]); rect(g, 86, 132, 52, 1, '#71503c');
  spr(g, [[94, 152, 8, 5, C.chair], [122, 152, 8, 5, C.chair]]);
  bookshelf(g, 20, 178, 11);
  for (const [px, py] of [[24, 63], [232, 63], [264, 47], [376, 47], [216, 207], [216, 335], [408, 63], [616, 191]]) plant(g, px, py);
  spr(g, [[258, 322, 28, 5, '#4a3a2c']]); rect(g, 260, 327, 2, 6, '#2a2018'); rect(g, 282, 327, 2, 6, '#2a2018');
  spr(g, [[370, 302, 12, 20, '#2a2d36'], [369, 299, 14, 4, '#3a3e4a']]);
  rect(g, 372, 305, 8, 3, C.info); rect(g, 373, 312, 6, 6, '#0f1014'); rect(g, 375, 314, 2, 3, '#dddddd');
  spr(g, [[530, 162, 56, 9, '#3b3550'], [530, 171, 56, 10, '#4a4363'], [527, 164, 4, 17, '#352f48'], [585, 164, 4, 17, '#352f48']]);
  rect(g, 557, 171, 1, 10, '#3b3550');
  return c;
}

const BX0 = 112, BX1 = 520, RX0 = 120, RX1 = 476;
function drawBuildingBG(paths) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), r = makePrng(5);
  const sky = g.createLinearGradient(0, 0, 0, 326);
  sky.addColorStop(0, '#04060b'); sky.addColorStop(1, '#10162a');
  g.fillStyle = sky; g.fillRect(0, 0, W, 326);
  for (let i = 0; i < 80; i++) rect(g, Math.floor(r() * W), Math.floor(r() * 210), 1, 1, r() < 0.2 ? '#ffffff' : '#7d86a6');
  for (let dy = -8; dy <= 8; dy++) { const w = Math.round(Math.sqrt(64 - dy * dy)); rect(g, 590 - w, 32 + dy, w * 2, 1, '#e8e6d8'); }
  rect(g, 586, 28, 3, 2, '#cfcdbf'); rect(g, 592, 35, 2, 2, '#cfcdbf');
  for (const [x, w, top] of [[0, 26, 196], [24, 30, 150], [52, 24, 214], [74, 34, 172], [528, 28, 182], [554, 36, 138], [588, 24, 206], [610, 30, 166]]) {
    rect(g, x, top, w, 326 - top, '#0a0d16'); rect(g, x, top, w, 1, '#151b2b');
    for (let yy = top + 6; yy < 318; yy += 7) for (let xx = x + 3; xx < x + w - 3; xx += 5) rect(g, xx, yy, 2, 3, r() < 0.26 ? (r() < 0.5 ? '#c9a85a' : '#6a5a30') : '#111624');
  }
  rect(g, 0, 326, W, 8, '#20222a'); rect(g, 0, 326, W, 1, '#2e313b'); rect(g, 0, 334, W, 18, '#0f1014');
  for (let x = 0; x < W; x += 24) rect(g, x + 4, 343, 12, 1, '#3a3d45');
  rect(g, 63, 268, 2, 58, '#3a3e4a'); rect(g, 58, 266, 10, 3, '#4a4f5c'); rect(g, 60, 269, 6, 1, '#ffd27a');
  rect(g, 108, 40, 416, 6, C.cap); rect(g, 108, 36, 4, 4, C.cap); rect(g, 520, 36, 4, 4, C.cap);
  spr(g, [[478, 22, 38, 18, '#2c2f39']]); rect(g, 483, 27, 10, 6, '#1b1d23'); rect(g, 498, 27, 12, 2, '#1b1d23'); rect(g, 498, 31, 12, 2, '#1b1d23');
  rect(g, 495, 2, 2, 20, '#5a6170'); rect(g, 491, 8, 10, 1, '#5a6170'); rect(g, 492, 14, 8, 1, '#5a6170');
  spr(g, [[146, 28, 16, 6, '#7d828c'], [152, 34, 4, 6, '#4a4f5c']]); rect(g, 147, 28, 14, 1, '#9aa0aa');
  spr(g, [[180, 30, 20, 10, '#3a3e4a']]); rect(g, 183, 33, 14, 4, '#2a2d36');
  rect(g, 236, 34, 168, 2, '#2a2d36'); rect(g, 244, 34, 2, 6, '#3a3e4a'); rect(g, 394, 34, 2, 6, '#3a3e4a');
  const pal = {
    atico: ['#2b2119', '#251c15', '#3a2c20'], nube: [C.nube, C.nubeDot, '#262137'],
    casa: [C.casa, C.casaDot, '#1d2636'], baja: [C.hall2, C.hallLine, '#24262e'],
  };
  for (const f of FLOORS) {
    const y0 = f.y0, [wallC, pat, strip] = pal[f.key];
    rect(g, RX0, y0, RX1 - RX0, 64, wallC);
    if (f.key === 'atico') for (let x = RX0 + 6; x < RX1; x += 12) rect(g, x, y0, 1, 58, pat);
    if (f.key === 'nube') for (let y = y0 + 3; y < y0 + 58; y += 4) for (let x = RX0 + 3; x < RX1; x += 4) rect(g, x, y, 1, 1, pat);
    if (f.key === 'casa') for (let y = y0; y < y0 + 58; y++) for (let x = RX0; x < RX1; x++) if ((x + y) % 8 === 0) rect(g, x, y, 1, 1, pat);
    if (f.key === 'baja') { for (let x = RX0; x < RX1; x += 16) rect(g, x, y0, 1, 58, pat); for (let y = y0 + 15; y < y0 + 58; y += 16) rect(g, RX0, y, RX1 - RX0, 1, pat); }
    rect(g, RX0, y0 + 58, RX1 - RX0, 6, strip); rect(g, RX0, y0 + 58, RX1 - RX0, 1, shade(strip, 1.3));
    if (f.key === 'casa') {
      // El CPD al fondo de la planta 1: paneles fríos, suelo técnico y tabique.
      const cx0 = CPD_B.x, cw = RX1 - cx0;
      rect(g, cx0, y0, cw, 58, '#1a1e26');
      for (let x = cx0 + 12; x < RX1; x += 13) rect(g, x, y0, 1, 58, '#151920');
      rect(g, cx0, y0 + 58, cw, 6, C.cpd); rect(g, cx0, y0 + 58, cw, 1, C.cpdHi);
      for (let x = cx0; x < RX1; x += 12) rect(g, x, y0 + 58, 1, 6, C.cpdLine);
      rect(g, cx0 - 4, y0, 4, 64, C.wall); rect(g, cx0 - 4, y0, 1, 64, C.wallHi); rect(g, cx0 - 1, y0, 1, 64, C.wallLo);
    }
    rect(g, RX0, y0, RX1 - RX0, 2, 'rgba(0,0,0,.4)');
    for (let x = RX0 + 40; x < RX1 - 20; x += 90) rect(g, x, y0 + 1, 10, 1, '#4a4f5c');
    rect(g, BX0, y0 + 64, BX1 - BX0, 6, C.slab); rect(g, BX0, y0 + 64, BX1 - BX0, 1, C.slabHi);
  }
  rect(g, BX0, 46, 8, 280, '#2a2d36'); rect(g, BX0, 46, 1, 280, '#3a3e4a');
  rect(g, 512, 46, 8, 280, '#2a2d36'); rect(g, 519, 46, 1, 280, '#1f2128');
  rect(g, 480, 46, 32, 274, '#0d0f14'); rect(g, 480, 46, 2, 274, '#262931'); rect(g, 510, 46, 2, 274, '#262931');
  rect(g, 486, 46, 1, 274, '#1c1f27'); rect(g, 505, 46, 1, 274, '#1c1f27');
  for (const f of FLOORS) rect(g, 482, f.y0 + 64, 28, 2, '#1c1f27');
  rect(g, 476, 46, 4, 274, '#14161c');
  drawCables(g, paths);
  let y0 = FLOORS[FI.atico].y0;
  nightWindow(g, 154, y0 + 6, 80, 24, 21); nightWindow(g, 314, y0 + 6, 128, 24, 22);
  bookshelf(g, 124, y0 + 34, 13);
  spr(g, [[372, y0 + 46, 60, 9, '#3b3550'], [372, y0 + 55, 60, 9, '#4a4363'], [369, y0 + 48, 4, 16, '#352f48'], [431, y0 + 48, 4, 16, '#352f48']]);
  spr(g, [[226, y0 + 61, 90, 3, '#33263d']]);
  plant(g, 462, y0 + 64);
  y0 = FLOORS[FI.nube].y0;
  nightWindow(g, 232, y0 + 6, 32, 18, 31); nightWindow(g, 338, y0 + 6, 32, 18, 32);
  spr(g, [[386, y0 + 40, 8, 6, C.chair], [420, y0 + 40, 8, 6, C.chair]]);
  spr(g, [[378, y0 + 46, 58, 10, '#5c4030'], [378, y0 + 56, 58, 8, '#3f2b1f']]); rect(g, 378, y0 + 46, 58, 1, '#71503c');
  plant(g, 134, y0 + 64); plant(g, 462, y0 + 64);
  y0 = FLOORS[FI.casa].y0;
  nightWindow(g, 206, y0 + 6, 32, 18, 41); nightWindow(g, 296, y0 + 6, 32, 18, 42);
  plant(g, 134, y0 + 64);
  // Bajada del cable del techo al router y extintor.
  rect(g, CPD_B.devX - 1, y0 + 3, 3, 11, C.cable); rect(g, CPD_B.devX - 1, y0 + 3, 1, 11, C.cableHi);
  spr(g, [[429, y0 + 45, 6, 13, '#c43c3c'], [430, y0 + 42, 4, 3, '#2a2d36']]); rect(g, 430, y0 + 47, 1, 9, '#e0605c'); rect(g, 429, y0 + 50, 6, 2, '#e8e4da');
  y0 = FLOORS[FI.baja].y0;
  spr(g, [[124, y0 + 10, 42, 54, '#0e1015']]);
  rect(g, 126, y0 + 12, 18, 52, '#13233a'); rect(g, 146, y0 + 12, 18, 52, '#13233a');
  rect(g, 128, y0 + 14, 2, 46, '#1d3555'); rect(g, 148, y0 + 14, 2, 46, '#1d3555');
  rect(g, 141, y0 + 36, 2, 6, '#5a6170'); rect(g, 147, y0 + 36, 2, 6, '#5a6170');
  drawLogo(g, 292, y0 + 4);
  spr(g, [[386, y0 + 52, 30, 5, '#4a3a2c']]); rect(g, 388, y0 + 57, 2, 7, '#2a2018'); rect(g, 412, y0 + 57, 2, 7, '#2a2018');
  plant(g, 196, y0 + 64); plant(g, 462, y0 + 64);
  rect(g, 120, 326, 50, 2, '#2a2d35');
  return c;
}

/* ---------- Qué está haciendo cada uno, según sus contenedores ---------- */
const ACTIVITY = [
  [/portainer_agent|portainer\/agent/i, 'Pasándole partes a Portainer'],
  [/portainer/i, 'Vigilando los contenedores de todos'],
  [/nginx|traefik|caddy|proxy/i, 'Repartiendo el tráfico de las webs'],
  [/pihole|adguard/i, 'Bloqueando anuncios en casa'],
  [/cloudflared|tunnel/i, 'Manteniendo abierto el túnel'],
  [/watchtower/i, 'Buscando versiones nuevas de las imágenes'],
  [/home-?assistant/i, 'Encendiendo y apagando luces'],
  [/mosquitto|mqtt/i, 'Repartiendo mensajes MQTT'],
  [/zigbee/i, 'Hablando con los sensores Zigbee'],
  [/panel/i, 'Recogiendo las métricas de todos'],
  [/vaixa/i, 'Atendiendo reservas de vaixataxi.es'],
  [/postgres|mariadb|mysql|mongo|redis/i, 'Ordenando la base de datos'],
  [/nextcloud/i, 'Sincronizando archivos'],
  [/backup|restic|duplicati/i, 'Haciendo copias de seguridad'],
  [/grafana|prometheus|uptime/i, 'Vigilando gráficas'],
  [/jellyfin|plex/i, 'Sirviendo películas'],
  [/contenedor lxc/i, 'Cuidando de un contenedor LXC'],
  [/máquina virtual/i, 'Cuidando de una máquina virtual'],
];
function activityFor(c) { const k = `${c.name} ${c.image ?? ''}`; for (const [re, t] of ACTIVITY) if (re.test(k)) return t; return `Ocupado con ${c.name}`; }
function pickActivity(a) {
  const run = a.containers.filter((c) => c.state === 'running' || /^up/i.test(c.status ?? ''));
  return run.length ? activityFor(pick(run)) : a.containers.length ? 'Esperando instrucciones' : 'Vigilando el servidor';
}
function crashed(a) { return a.containers.filter((c) => isContainerProblem(c)); }
function toneOf(a) {
  if (!a.online) return 'bad';
  if (crashed(a).length) return 'bad';
  if (a.cpu > THRESHOLDS.cpu || a.ram > THRESHOLDS.ram || (a.disk ?? 0) > THRESHOLDS.disk) return 'warn';
  return 'ok';
}
const TONE_RGB = { ok: '110,180,255', warn: '255,200,60', bad: '255,77,77' };
const TONE_COLOR = { ok: C.ok, warn: C.warn, bad: C.bad, info: C.info, idle: '#6e737c' };
function noteColor(c, now) {
  if (c.state === 'running') return '#46d39a';
  if (c.state === 'restarting') return Math.floor(now / 220) % 2 ? C.warn : '#7a6420';
  if (isContainerProblem(c)) return C.bad;
  if (c.state === 'unknown') return '#46d39a';
  return '#7d828c';
}

/* ---------- Escena ---------- */
export function createScene(o: SceneOptions) {
  const { canvas, world, stageScroll, overlays } = o;
  const ctx = canvas.getContext('2d');
  let mode: SceneMode = 'oficina';
  let S = 2, selected = null, hoverId = null, focusRoom = null, destroyed = false;
  let actors = [];                 // empleados con mesa
  const byKey = new Map();         // todos los conocidos (con o sin mesa)
  const packets = [];
  const routerFlash = {};
  let bgOffice = null, bgBuilding = null, blocked = null;
  const results = new Map();       // resultados de encargos que llegan antes que tú

  const RECEP = {
    key: RECEPTION_KEY, serverId: RECEPTION_KEY, title: 'Recepción', cx: 320, topY: 146, bx: 300, floor: 'baja', stand: [20, 11], online: true,
    look: lookFor(RECEPTION_KEY), webs: [], task: null, bubble: null, nextChat: Date.now() + 2500, doing: 'Atendiendo el teléfono',
    anim: newAnim(), plates: [], bubbles: [],
  };
  const BOSS = { cx: 120, topY: 242, bx: 270 };
  const boss = {
    state: 'seated', tile: [7, 14], x: 7 * T + 8, y: 14 * T + 13, dir: 'down', path: [], pathLen0: 1, queue: [], job: null, hand: null,
    frame: 0, frameT: 0, blink: false, blinkAt: Date.now() + 2000, floorNow: FI.atico, fromF: FI.atico, toF: FI.atico,
  };

  function newAnim() {
    const now = Date.now();
    return { phase: rnd(0, 5), lo: 0, ro: 0, bob: 0, blink: false, blinkAt: now + rnd(500, 4000), sip: false, sipUntil: 0, sipNext: now + rnd(4000, 14000), talk: false, sweat: false, sweatY: 0 };
  }

  /* --- Superposición HTML: placas, bocadillos y carteles --- */
  function place(el, x, y) { el.style.left = (x / W) * 100 + '%'; el.style.top = (y / H) * 100 + '%'; }
  function addLabel(where, cls, html, x, y) { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; place(el, x, y); overlays[where].append(el); return el; }
  addLabel('oficina', 'sc-room', 'Planta 2 · Nube', 22, 170);
  addLabel('oficina', 'sc-room', 'Planta 1 · Casa', 412, 180);
  addLabel('oficina', 'sc-room', 'Planta 1 · CPD', 412, 326);
  addLabel('oficina', 'sc-room', 'Ático · Despacho', 22, 326);
  addLabel('oficina', 'sc-company', '<b>marcogugliandolo.com</b><span>Planta baja · Recepción</span>', 320, 262);
  addLabel('oficina', 'sc-sign', 'Internet', 320, 1.5);
  addLabel('edificio', 'sc-rooftop', 'marcogugliandolo.com', 320, 25);
  addLabel('edificio', 'sc-sign sc-left', 'Internet', 503, 3);
  addLabel('edificio', 'sc-room', 'CPD', CPD_B.x + 3, FLOORS[FI.casa].y0 + 9);

  /* Equipo de red del CPD: los nodos del esquema que no son servidores (router, firewall…). */
  let net: SceneNetDevice[] = [DEFAULT_ROUTER], netSig = '', netPlates = [];
  function setNet(list: SceneNetDevice[]) {
    const next = list.length ? list.slice(0, NET_X.length) : [DEFAULT_ROUTER];
    const sig = JSON.stringify(next);
    if (sig === netSig) return;
    netSig = sig; net = next;
    for (const el of netPlates) el.remove();
    const withIp = net.length === 1;
    netPlates = net.map((d, i) =>
      addLabel('oficina', 'sc-plate sc-static', esc(d.title) + (withIp && d.detail ? ` · ${esc(d.detail)}` : ''), NET_X[i], 284),
    );
    netPlates.push(addLabel('edificio', 'sc-plate sc-static', esc(net[0].title), CPD_B.devX, FLOORS[FI.casa].y0 + 41));
  }
  setNet([]);
  const bossPlates = [addLabel('oficina', 'sc-plate sc-static', 'Tú', 120, 270), addLabel('edificio', 'sc-plate sc-static', 'Tú', BOSS.bx, FLOORS[FI.atico].y0 + 54)];
  const floorTags = FLOORS.map((f) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sc-floor';
    b.innerHTML = `<span><small>${f.label}</small>${f.name}</span><span class="sc-dot"></span>`;
    b.setAttribute('aria-label', `Ver ${f.label} (${f.name}) en la oficina`);
    place(b, 104, f.y0 + 32);
    b.addEventListener('click', () => o.onFloor(f.key));
    overlays.edificio.append(b);
    return { f, b };
  });
  function attachOverlay(a) {
    for (const el of [...a.plates, ...a.bubbles]) el.remove();
    a.plates = []; a.bubbles = [];
    if (!a.inScene) return;
    const bp = bPos(a);
    for (const [where, px, py, by] of [['oficina', a.cx, a === RECEP ? 172 : 93, a === RECEP ? 126 : 46], ['edificio', bp.cx, bp.y0 + (a === RECEP ? 52 : 54), bp.y0 + 22]]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sc-plate';
      b.innerHTML = `<span class="sc-dot"></span>${esc(a.title)}`;
      b.setAttribute('aria-label', `Ver la ficha de ${a.title}`);
      place(b, px, py); b.addEventListener('click', () => o.onSelect(a.key));
      overlays[where].append(b); a.plates.push(b);
      const bub = document.createElement('div');
      bub.className = 'sc-bubble'; bub.setAttribute('aria-hidden', 'true');
      if (a.bubble) { bub.textContent = a.bubble.text; bub.dataset.tone = a.bubble.tone; bub.classList.add('sc-show'); }
      place(bub, px, by); overlays[where].append(bub); a.bubbles.push(bub);
    }
  }
  RECEP.inScene = true;
  attachOverlay(RECEP);

  function say(a, text, tone = '', ms = 4400) {
    a.bubble = { text, tone, until: Date.now() + ms };
    for (const el of a.bubbles) { el.textContent = text; el.dataset.tone = tone; el.classList.add('sc-show'); }
  }
  function hush(a) { a.bubble = null; for (const el of a.bubbles) el.classList.remove('sc-show'); }

  /* --- Posiciones --- */
  function floorOf(a) { return a === RECEP ? FI.baja : FI[a.floor]; }
  function bPos(a) { const f = FLOORS[floorOf(a)]; return { cx: a.bx, ty: f.y0 + (a === RECEP ? 41 : 42), wy: f.y0 + 5, y0: f.y0 }; }
  function hitRect(a) {
    if (mode === 'edificio') { const p = bPos(a); return a === RECEP ? [p.cx - 34, p.y0 + 14, 68, 50] : [p.cx - 27, p.y0 + 2, 54, 62]; }
    return a === RECEP ? [284, 118, 72, 54] : [a.cx - 27, 2, 54, 92];
  }

  /* --- Reparto de mesas y fondos --- */
  function relayout() {
    const want = { nube: [], casa: [] };
    for (const a of byKey.values()) want[a.data.floor === 'nube' ? 'nube' : 'casa'].push(a);
    const free = { nube: [...SLOTS.nube], casa: [...SLOTS.casa] };
    const placed = [];
    for (const floor of ['nube', 'casa']) {
      for (const a of want[floor]) {
        let slotFloor = floor;
        if (!free[floor].length) slotFloor = floor === 'nube' ? 'casa' : 'nube';
        const slot = free[slotFloor].shift();
        if (!slot) { a.inScene = false; continue; }
        Object.assign(a, { inScene: true, floor: slotFloor, cx: slot.cx, bx: slot.bx, stand: [Math.floor(slot.cx / T), 6] });
        a.paths = { oficina: officePath(slotFloor, slot.cx), edificio: buildingPath(slotFloor, slot.bx) };
        placed.push(a);
      }
    }
    actors = placed;
    const { b, block } = baseBlocked();
    for (const a of actors) block(Math.floor((a.cx - 24) / T), 3, Math.floor((a.cx + 23) / T), 5);
    blocked = b;
    bgOffice = drawOfficeBG(actors.map((a) => a.paths.oficina));
    bgBuilding = drawBuildingBG(actors.map((a) => a.paths.edificio));
    for (const a of byKey.values()) attachOverlay(a);
    packets.length = 0;
    refreshPlates();
  }
  relayout();

  /* --- Datos que llegan del panel --- */
  function setData(servers: SceneServer[], webs: SceneWeb[], netDevices: SceneNetDevice[] = []) {
    setNet(netDevices);
    const keys = new Set(servers.map((s) => s.key));
    let changed = false;
    for (const [k, a] of byKey) if (!keys.has(k)) { for (const el of [...a.plates, ...a.bubbles]) el.remove(); byKey.delete(k); changed = true; }
    for (const s of servers) {
      let a = byKey.get(s.key);
      if (!a) {
        a = { key: s.key, serverId: s.serverId, title: s.title, look: lookFor(s.serverId), hist: [], task: null, bubble: null, plates: [], bubbles: [],
          nextChat: Date.now() + rnd(400, 6000), doing: '', seed: rnd(0, 10), spawnAcc: rnd(0, 1), anim: newAnim(), data: s, inScene: false };
        byKey.set(s.key, a); changed = true;
      }
      if (a.data.floor !== s.floor || a.title !== s.title) changed = true;
      a.data = s; a.title = s.title; a.serverId = s.serverId;
      a.online = s.online; a.cpu = s.cpu; a.ram = s.ram; a.disk = s.disk; a.containers = s.containers;
      a.hist.push(s.cpu); if (a.hist.length > 24) a.hist.shift();
      if (!a.doing) a.doing = s.online ? pickActivity(a) : '';
      if (!a.online && a.bubble && a.bubble.tone !== 'task') hush(a);
    }
    // Orden de entrada = orden en el esquema; se respeta al repartir mesas.
    const order = servers.map((s) => s.key);
    const sorted = new Map([...byKey.entries()].sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])));
    byKey.clear(); for (const [k, v] of sorted) byKey.set(k, v);
    RECEP.webs = webs.slice(0, 4);
    if (changed) relayout(); else refreshPlates();
  }

  function refreshPlates() {
    for (const a of [...actors, RECEP]) for (const p of a.plates) {
      const tone = a === RECEP ? (RECEP.webs.some((w) => w.down) ? 'bad' : 'ok') : !a.online ? 'idle' : toneOf(a);
      p.firstElementChild.className = 'sc-dot sc-' + tone;
      p.setAttribute('aria-pressed', String(selected === a.key));
    }
    for (const { f, b } of floorTags) {
      const list = f.key === 'baja' ? [RECEP] : actors.filter((a) => a.floor === f.key);
      const tones = list.map((a) => (a === RECEP ? (RECEP.webs.some((w) => w.down) ? 'bad' : 'ok') : toneOf(a)));
      b.lastElementChild.className = 'sc-dot sc-' + (tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : 'ok');
    }
  }

  /* --- Dibujo de piezas con estado --- */
  function drawWall(g, a, now, cx, wy) {
    const sx = cx - 23, sy = wy, w = 28, h = 22, ix = sx + 2, iy = sy + 2, iw = w - 4, ih = h - 4;
    spr(g, [[sx, sy, w, h, C.screenFrame]]);
    if (!a.online) {
      rect(g, ix, iy, iw, ih, '#0b0c0f');
      if (!REDUCED) for (let i = 0; i < 16; i++) rect(g, ix + Math.floor(Math.random() * iw), iy + Math.floor(Math.random() * ih), 1, 1, Math.random() < 0.5 ? '#2a2d36' : '#3a3e4a');
    } else if (a.task) {
      rect(g, ix, iy, iw, ih, '#07140f');
      const p = a.task.result ? 1 : clamp((now - a.task.start) / 4000, 0, 0.9);
      rect(g, ix + 2, iy + 6, iw - 4, 4, C.screenTrack); rect(g, ix + 2, iy + 6, Math.round((iw - 4) * p), 4, C.ok);
      for (let k = 0; k < 3; k++) if (Math.floor(now / 250) % 3 >= k) rect(g, ix + 2 + k * 3, iy + 12, 2, 2, C.ok);
    } else {
      rect(g, ix, iy, iw, ih, toneOf(a) === 'bad' ? '#1a0b0d' : '#07140f');
      const vals = [a.cpu, a.ram, a.disk ?? 0], lim = [THRESHOLDS.cpu, THRESHOLDS.ram, THRESHOLDS.disk];
      vals.forEach((v, i) => { const y = iy + 2 + i * 3; rect(g, ix + 2, y, iw - 4, 2, C.screenTrack); rect(g, ix + 2, y, Math.max(1, Math.round(((iw - 4) * v) / 100)), 2, v > lim[i] ? C.warn : C.ok); });
      a.hist.slice(-(iw - 4)).forEach((v, k) => { const hh = Math.max(1, Math.round((v / 100) * 5)); rect(g, ix + 2 + k, iy + ih - 2 - hh, 1, hh, '#2f6fb8'); });
    }
    const kx = cx + 8, ky = wy + 3;
    spr(g, [[kx, ky, 15, 16, C.corkFrame]]); rect(g, kx + 1, ky + 1, 13, 14, C.cork);
    a.containers.slice(0, 9).forEach((c, i) => {
      const x = kx + 2 + (i % 3) * 4, y = ky + 2 + Math.floor(i / 3) * 4, col = noteColor(c, now);
      rect(g, x, y, 3, 3, a.online ? col : shade(col, 0.45));
      rect(g, x + 1, y, 1, 1, 'rgba(0,0,0,.4)');
    });
  }
  function drawCubicle(g, a, now, cx, ty) {
    const A = a.anim, off = a.online ? 0 : 3;
    spr(g, [[cx - 7, ty - 16 + off, 14, 15, C.chair], [cx - 6, ty - 15 + off, 12, 2, C.chairHi, false]]);
    if (a.online) drawSeated(g, cx, ty, a.look, A);
    drawDesk(g, cx, ty, 48);
    spr(g, [[cx - 21, ty + 1, 5, 2, C.lampArm], [cx - 20, ty - 6, 1, 7, C.lampArm], [cx - 22, ty - 8, 6, 3, a.online ? C.lampHead : C.lampOff]]);
    drawPapers(g, cx - 21, ty + 12, a.online ? 1 + Math.round(a.ram / 22) : 2, a.online && a.ram > THRESHOLDS.ram);
    if (!A.sip || !a.online) spr(g, [[cx - 12, ty + 4, 4, 4, C.mug], [cx - 8, ty + 5, 1, 2, C.mug], [cx - 11, ty + 4, 2, 1, C.coffee, false]]);
    spr(g, [[cx - 6, ty + 5, 12, 3, C.keyboard], [cx - 6, ty + 5, 12, 1, C.keyboardHi, false]]);
    if (a.online) drawHands(g, cx, ty, a.look, A.lo, A.ro, A.sip);
    const tone = toneOf(a);
    spr(g, [[cx + 8, ty - 9, 14, 11, C.monitor], [cx + 13, ty + 2, 4, 3, C.monitor]]);
    rect(g, cx + 8, ty - 9, 14, 1, C.monitorHi);
    rect(g, cx + 14, ty - 5, 2, 2, !a.online ? '#2a2d36' : a.task ? C.ok : tone === 'ok' ? C.info : TONE_COLOR[tone]);
  }
  const PHONE_X = [-28, -18, 11, 21];
  function drawReception(g, now, cx, ty) {
    const R = RECEP;
    spr(g, [[cx - 7, ty - 16, 14, 15, C.chair], [cx - 6, ty - 15, 12, 2, C.chairHi, false]]);
    drawSeated(g, cx, ty, R.look, R.anim);
    rect(g, cx - 30, ty + 23, 62, 3, 'rgba(0,0,0,.35)');
    spr(g, [[cx - 32, ty, 64, 14, C.counterTop], [cx - 32, ty + 14, 64, 9, C.counterFront]]);
    rect(g, cx - 32, ty, 64, 1, '#5d6373'); rect(g, cx - 32, ty + 17, 64, 1, 'rgba(90,156,240,.55)');
    rect(g, cx - 3, ty + 15, 6, 6, '#00c97c');
    spr(g, [[cx - 6, ty + 5, 12, 3, C.keyboard], [cx - 6, ty + 5, 12, 1, C.keyboardHi, false]]);
    drawHands(g, cx, ty, R.look, R.anim.lo, R.anim.ro, false);
    R.webs.forEach((w, i) => {
      const px = cx + PHONE_X[i], ring = w.down && Math.floor(now / 160) % 2;
      spr(g, [[px, ty + 5, 7, 4, '#1b1d23'], [px, ty + 3 - (ring ? 2 : 0), 7, 2, '#2c2f39']]);
      rect(g, px + 5, ty + 7, 1, 1, w.down ? (Math.floor(now / 300) % 2 ? C.bad : '#5a1a1a') : C.ok);
    });
  }
  function routerLed(a, now) { return !a.online ? '#4a1a1a' : now - (routerFlash[a.key] || 0) < 110 ? '#ffffff' : C.ok; }
  function casaActors() { return actors.filter((a) => a.floor === 'casa'); }
  const wanBlink = (now) => (Math.floor(now / 400) % 2 ? C.info : '#1d3555');

  /* Aparatos de red del esquema. (x, y) es la esquina superior izquierda de la caja; la base queda en y + 16. */
  function drawNetDevice(g, now, kind, cx, y, linked) {
    const x = cx - 16;
    rect(g, x + 2, y + 16, 30, 3, 'rgba(0,0,0,.35)');
    if (kind === 'router') {
      spr(g, [[x, y, 32, 10, '#3a3f4c'], [x, y + 10, 32, 6, '#2a2e38']]); rect(g, x, y, 32, 1, '#4a505e');
      spr(g, [[x + 4, y - 6, 24, 8, '#16181d'], [x + 6, y - 12, 1, 6, '#2a2d36'], [x + 25, y - 12, 1, 6, '#2a2d36']]);
      if (linked) casaActors().slice(0, 3).forEach((a, i) => rect(g, x + 8 + i * 6, y - 3, 3, 1, routerLed(a, now)));
      rect(g, x + 24, y - 3, 1, 1, wanBlink(now));
    } else if (kind === 'firewall') {
      spr(g, [[x + 2, y + 2, 28, 8, '#4a2f2a'], [x + 2, y + 10, 28, 6, '#33211d']]); rect(g, x + 2, y + 2, 28, 1, '#6a443c');
      rect(g, x + 4, y + 12, 24, 1, '#e08a3c');
      for (let i = 0; i < 4; i++) rect(g, x + 6 + i * 5, y + 5, 2, 1, Math.floor(now / 300 + i) % 3 ? C.ok : '#0f3a26');
    } else {
      spr(g, [[x + 4, y, 24, 10, '#3a3e4a'], [x + 4, y + 10, 24, 6, '#2a2d36']]); rect(g, x + 4, y, 24, 1, '#4a4f5c');
      for (let i = 0; i < 3; i++) rect(g, x + 7 + i * 7, y + 3, 5, 5, '#22252d');
      rect(g, x + 24, y + 12, 1, 1, wanBlink(now));
    }
  }

  /* Racks del CPD en el plano: red (switch con una luz por equipo de casa), equipos de casa y SAI. */
  function drawRackFrame(g, x, y) {
    rect(g, x + 2, y + 48, 22, 3, 'rgba(0,0,0,.35)');
    spr(g, [[x, y, 24, 5, C.rackTop], [x, y + 5, 24, 43, C.rack]]);
    rect(g, x, y, 24, 1, '#4a4f5c'); rect(g, x + 1, y + 6, 1, 41, C.rackFrame); rect(g, x + 22, y + 6, 1, 41, C.rackFrame);
  }
  function drawRacksOffice(g, now) {
    const y = 210, casa = casaActors().slice(0, 6);
    // 1. Red: panel de parcheo, switch y bandeja.
    let x = RACK_X[0];
    drawRackFrame(g, x, y);
    rect(g, x + 3, y + 8, 18, 4, C.rackUnit); for (let i = 0; i < 8; i++) rect(g, x + 4 + i * 2, y + 9, 1, 2, '#3a3e4a');
    rect(g, x + 3, y + 14, 18, 5, C.rackUnit);
    casa.forEach((a, i) => rect(g, x + 4 + i * 3, y + 16, 2, 1, routerLed(a, now)));
    rect(g, x + 19, y + 16, 1, 1, wanBlink(now));
    for (let i = 0; i < 3; i++) rect(g, x + 3, y + 22 + i * 7, 18, 5, '#191b21');
    // 2. Un equipo por servidor de casa: luz de estado y luz de actividad.
    x = RACK_X[1];
    drawRackFrame(g, x, y);
    for (let i = 0; i < 6; i++) {
      const uy = y + 8 + i * 6.5, a = casa[i];
      rect(g, x + 3, Math.round(uy), 18, 5, a ? C.rackUnit : '#16181d');
      if (!a) continue;
      for (let k = 0; k < 3; k++) rect(g, x + 9 + k * 3, Math.round(uy) + 1, 2, 3, '#262a33');
      rect(g, x + 4, Math.round(uy) + 2, 2, 1, a.online ? TONE_COLOR[toneOf(a)] : '#3a1414');
      rect(g, x + 19, Math.round(uy) + 2, 1, 1, routerLed(a, now));
    }
    // 3. SAI abajo y paneles ciegos.
    x = RACK_X[2];
    drawRackFrame(g, x, y);
    for (let i = 0; i < 3; i++) rect(g, x + 3, y + 8 + i * 6, 18, 5, '#191b21');
    rect(g, x + 3, y + 32, 18, 13, '#23262e'); rect(g, x + 5, y + 34, 8, 4, '#07140f');
    rect(g, x + 6, y + 35, 1 + (Math.floor(now / 2000) % 5), 2, C.ok);
    rect(g, x + 16, y + 35, 2, 1, C.ok);
  }

  /* Rack y router en el corte del edificio (planta 1, a la derecha). */
  function drawCpdBuilding(g, now, y0) {
    const x = CPD_B.rackX;
    spr(g, [[x, y0 + 20, 20, 44, C.rack]]); rect(g, x, y0 + 20, 20, 1, '#3a3e4a');
    for (let i = 0; i < 4; i++) rect(g, x + 2, y0 + 23 + i * 10, 16, 8, '#202329');
    casaActors().slice(0, 4).forEach((a, i) => {
      rect(g, x + 4, y0 + 26 + i * 10, 2, 1, a.online ? TONE_COLOR[toneOf(a)] : '#3a1414');
      rect(g, x + 8, y0 + 26 + i * 10, 8, 1, '#2f333e');
      rect(g, x + 14, y0 + 28 + i * 10, 2, 1, routerLed(a, now));
    });
    rect(g, x + 4, y0 + 56, 2, 1, wanBlink(now));
    spr(g, [[CPD_B.devX - 18, y0 + 36, 36, 3, '#5c4030']]);
    drawNetDevice(g, now, net[0].kind, CPD_B.devX, y0 + 20, true);
  }
  function drawBossDesk(g, now, cx, ty, seated) {
    spr(g, [[cx - 8, ty - 18, 16, 17, '#1b1d24'], [cx - 7, ty - 17, 14, 2, '#2a2d36', false]]);
    if (seated) drawSeated(g, cx, ty, BOSS_LOOK, { blink: boss.blink });
    drawDesk(g, cx, ty, 56, '#5b3b26', '#74503a', '#3f2819');
    spr(g, [[cx + 10, ty - 10, 16, 12, C.monitor], [cx + 16, ty + 2, 4, 3, C.monitor]]);
    rect(g, cx + 10, ty - 10, 16, 1, C.monitorHi); rect(g, cx + 17, ty - 5, 2, 2, C.ok);
    spr(g, [[cx - 6, ty + 5, 12, 3, C.keyboard], [cx - 6, ty + 5, 12, 1, C.keyboardHi, false]]);
    if (seated) drawHands(g, cx, ty, BOSS_LOOK, Math.floor(now / 900) % 2, Math.floor(now / 900 + 0.5) % 2, false);
    spr(g, [[cx - 24, ty + 1, 6, 2, '#8a7a50'], [cx - 22, ty - 5, 1, 6, '#8a7a50'], [cx - 26, ty - 8, 10, 3, '#1f6b4a']]);
    drawPapers(g, cx - 15, ty + 12, boss.queue.length + (boss.job ? 1 : 0) + 1, false);
  }
  function drawBossTV(g, x, y) {
    spr(g, [[x, y, 28, 9, C.screenFrame]]); rect(g, x + 1, y + 1, 26, 7, '#07140f');
    [...actors, RECEP].slice(0, 6).forEach((a, i) => {
      const tone = a === RECEP ? (RECEP.webs.some((w) => w.down) ? 'bad' : 'ok') : toneOf(a);
      rect(g, x + 3 + i * 4, y + 3, 3, 3, TONE_COLOR[tone]);
    });
  }
  function workerLights(a, cx, ty, screenY) {
    if (!a.online) return;
    glow(ctx, cx - 18, ty + 4, 34, '255,196,120', 0.16);
    const rgb = a.task ? '0,255,157' : TONE_RGB[toneOf(a)];
    glow(ctx, cx + 1, ty - 12, 18, rgb, 0.1); glow(ctx, cx - 9, screenY, 22, rgb, 0.07);
  }
  function packetPos(p) { const P = p.a.paths[mode]; return pointAt(P, (p.dir > 0 ? p.u : 1 - p.u) * P.len); }

  function renderOffice(now) {
    ctx.drawImage(bgOffice, 0, 0);
    for (const a of actors) drawWall(ctx, a, now, a.cx, 5);
    drawBossTV(ctx, 106, 181);
    const list = actors.map((a) => ({ y: DESK_Y + 22, f: () => drawCubicle(ctx, a, now, a.cx, DESK_Y) }));
    list.push({ y: RECEP.topY + 23, f: () => drawReception(ctx, now, RECEP.cx, RECEP.topY) });
    list.push({ y: 258, f: () => drawRacksOffice(ctx, now) });
    net.forEach((d, i) => list.push({ y: 278, f: () => drawNetDevice(ctx, now, d.kind, NET_X[i], 262, i === 0) }));
    list.push({ y: BOSS.topY + 22, f: () => drawBossDesk(ctx, now, BOSS.cx, BOSS.topY, boss.state === 'seated') });
    if (boss.state !== 'seated') list.push({ y: boss.y, f: () => drawWalker(ctx, Math.round(boss.x), Math.round(boss.y), BOSS_LOOK, boss.dir, boss.state === 'walking' || boss.state === 'returning', boss.frame, boss.state === 'walking') });
    list.sort((p, q) => p.y - q.y);
    for (const d of list) d.f();
    if (boss.hand) {
      const h = boss.hand, t = clamp((now - h.start) / h.dur, 0, 1), a = h.a;
      const from = [boss.x + 2, boss.y - 12], to = [a.cx - 2, (a === RECEP ? RECEP.topY : DESK_Y) + 4];
      spr(ctx, [[Math.round(from[0] + (to[0] - from[0]) * t), Math.round(from[1] + (to[1] - from[1]) * t - Math.sin(t * Math.PI) * 6), 5, 6, '#e9d8a6']]);
    }
    for (const p of packets) { const [x, y] = packetPos(p); rect(ctx, Math.round(x) - 1, Math.round(y) - 1, 2, 2, p.dir > 0 ? C.info : '#9fd0ff'); }
    for (const a of actors) if (!a.online) rect(ctx, a.cx - 30, 32, 60, 66, 'rgba(0,0,0,.42)');
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, 320, 40, 70, '90,156,240', 0.14);
    glow(ctx, 128, 22, 44, '90,120,220', 0.06); glow(ctx, 278, 22, 40, '90,120,220', 0.06);
    glow(ctx, 320, 220, 150, '140,150,190', 0.035);
    for (const a of actors) workerLights(a, a.cx, DESK_Y, 16);
    glow(ctx, 320, 150, 52, '255,196,120', 0.12);
    if (RECEP.webs.some((w) => w.down) && Math.floor(now / 300) % 2) glow(ctx, 320, 152, 40, '255,77,77', 0.14);
    glow(ctx, 98, 240, 44, '120,255,190', 0.07); glow(ctx, 120, 252, 64, '255,196,120', 0.1);
    glow(ctx, 376, 306, 12, '90,156,240', 0.3);
    // El CPD, con luz fría y el brillo de los racks.
    glow(ctx, 512, 268, 110, '110,160,255', 0.05);
    for (const x of RACK_X) glow(ctx, x + 12, 232, 16, '0,255,157', 0.06);
    glow(ctx, NET_X[0], 258, 20, '0,255,157', 0.08);
    for (const p of packets) { const [x, y] = packetPos(p); glow(ctx, x, y, 6, '90,156,240', 0.45); }
    ctx.globalCompositeOperation = 'source-over';
    if (focusRoom && now < focusRoom.until) {
      const [x, y, w, h] = FLOORS[FI[focusRoom.key]].room, al = 0.35 + 0.3 * Math.sin(now / 140);
      rect(ctx, x, y, w, h, 'rgba(0,255,157,.05)');
      const col = `rgba(0,255,157,${al.toFixed(2)})`;
      rect(ctx, x, y, w, 1, col); rect(ctx, x, y + h - 1, w, 1, col); rect(ctx, x, y, 1, h, col); rect(ctx, x + w - 1, y, 1, h, col);
    }
  }
  function carFloor() {
    if (boss.state === 'walking' || boss.state === 'returning') {
      const p = clamp(1 - boss.path.length / Math.max(1, boss.pathLen0), 0, 1), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      return { f: boss.fromF + (boss.toF - boss.fromF) * e, inside: true };
    }
    return { f: boss.floorNow, inside: false };
  }
  function renderBuilding(now) {
    ctx.drawImage(bgBuilding, 0, 0);
    for (const a of actors) { const p = bPos(a); drawWall(ctx, a, now, p.cx, p.wy); }
    const at = FLOORS[FI.atico].y0;
    drawBossTV(ctx, 256, at + 8);
    for (const a of actors) { const p = bPos(a); drawCubicle(ctx, a, now, p.cx, p.ty); }
    drawCpdBuilding(ctx, now, FLOORS[FI.casa].y0);
    const rp = bPos(RECEP); drawReception(ctx, now, rp.cx, rp.ty);
    drawBossDesk(ctx, now, BOSS.bx, at + 42, boss.state === 'seated');
    const car = carFloor(), cy = 110 + car.f * 70;
    rect(ctx, 491, 46, 1, Math.max(0, cy - 34 - 46), '#3a3e4a'); rect(ctx, 500, 46, 1, Math.max(0, cy - 34 - 46), '#3a3e4a');
    spr(ctx, [[484, cy - 34, 24, 34, '#3a3e4a']]);
    rect(ctx, 486, cy - 32, 20, 31, '#20232b'); rect(ctx, 489, cy - 31, 14, 1, '#e8e4da');
    if (car.inside) drawWalker(ctx, 496, Math.round(cy) - 2, BOSS_LOOK, 'down', false, 0, boss.state === 'walking');
    if (boss.state === 'handing' && boss.job) {
      const a = boss.job.a, p = bPos(a), bxp = p.cx - 32, by = p.y0 + 63;
      drawWalker(ctx, bxp, by, BOSS_LOOK, 'right', false, 0, false);
      if (boss.hand) {
        const t = clamp((now - boss.hand.start) / boss.hand.dur, 0, 1), from = [bxp + 4, by - 12], to = [p.cx - 6, p.ty + 2];
        spr(ctx, [[Math.round(from[0] + (to[0] - from[0]) * t), Math.round(from[1] + (to[1] - from[1]) * t - Math.sin(t * Math.PI) * 6), 5, 6, '#e9d8a6']]);
      }
    }
    const blinkOn = Math.floor(now / 700) % 2;
    rect(ctx, 495, 1, 2, 2, blinkOn ? C.bad : '#5a1a1a');
    for (const p of packets) { const [x, y] = packetPos(p); rect(ctx, Math.round(x) - 1, Math.round(y) - 1, 2, 2, p.dir > 0 ? C.info : '#9fd0ff'); }
    for (const a of actors) if (!a.online) { const p = bPos(a); rect(ctx, p.cx - 30, p.y0, 60, 64, 'rgba(0,0,0,.45)'); }
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, 64, 274, 52, '255,196,120', 0.2);
    glow(ctx, 590, 32, 30, '200,210,255', 0.08);
    for (let x = 250; x <= 390; x += 35) glow(ctx, x, 26, 28, '0,255,157', 0.09);
    if (blinkOn) glow(ctx, 496, 2, 12, '255,77,77', 0.55);
    for (const f of FLOORS) {
      const lit = f.key === 'atico' || f.key === 'baja' || actors.some((a) => a.floor === f.key && a.online);
      if (lit) for (let x = RX0 + 45; x < RX1 - 20; x += 90) glow(ctx, x, f.y0 + 6, 42, '255,220,170', 0.05);
    }
    for (const a of actors) { const p = bPos(a); workerLights(a, p.cx, p.ty, p.wy + 11); }
    glow(ctx, rp.cx, rp.ty + 2, 50, '255,196,120', 0.12);
    if (RECEP.webs.some((w) => w.down) && Math.floor(now / 300) % 2) glow(ctx, rp.cx, rp.ty, 46, '255,77,77', 0.16);
    glow(ctx, BOSS.bx - 22, at + 40, 40, '120,255,190', 0.07); glow(ctx, BOSS.bx, at + 50, 60, '255,196,120', 0.1);
    glow(ctx, 496, cy - 22, 20, '255,240,200', 0.12);
    glow(ctx, 145, FLOORS[FI.baja].y0 + 40, 40, '90,156,240', 0.1);
    glow(ctx, 438, FLOORS[FI.casa].y0 + 32, 44, '110,160,255', 0.06);
    glow(ctx, CPD_B.devX, FLOORS[FI.casa].y0 + 20, 18, '0,255,157', 0.08);
    glow(ctx, CPD_B.rackX + 10, FLOORS[FI.casa].y0 + 40, 16, '0,255,157', 0.06);
    for (const p of packets) { const [x, y] = packetPos(p); glow(ctx, x, y, 6, '90,156,240', 0.45); }
    ctx.globalCompositeOperation = 'source-over';
  }
  function render(now) {
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (mode === 'edificio') renderBuilding(now); else renderOffice(now);
    const sel = selected ? (selected === RECEPTION_KEY ? RECEP : actors.find((a) => a.key === selected)) : null;
    const hov = hoverId && hoverId !== selected ? (hoverId === RECEPTION_KEY ? RECEP : actors.find((a) => a.key === hoverId)) : null;
    if (hov) { const r = hitRect(hov); brackets(ctx, r[0], r[1], r[2], r[3], 'rgba(255,255,255,.45)'); }
    if (sel) { const r = hitRect(sel), off = REDUCED ? 0 : Math.floor(now / 400) % 2; brackets(ctx, r[0] - off, r[1] - off, r[2] + off * 2, r[3] + off * 2, C.ok); }
  }

  /* --- Encargos: vas a la mesa, entregas la carpeta y el empleado lo hace --- */
  function bfs(sx, sy, tx, ty) {
    const key = (x, y) => y * MW + x, prev = new Int32Array(MW * MH).fill(-1), q = [key(sx, sy)];
    prev[key(sx, sy)] = key(sx, sy);
    while (q.length) {
      const k = q.shift(), x = k % MW, y = (k / MW) | 0;
      if (x === tx && y === ty) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
        const nk = key(nx, ny);
        if (prev[nk] !== -1 || blocked[ny][nx]) continue;
        prev[nk] = k; q.push(nk);
      }
    }
    if (prev[key(tx, ty)] === -1) return null;
    const path = []; let k = key(tx, ty);
    while (k !== key(sx, sy)) { path.push([k % MW, (k / MW) | 0]); k = prev[k]; }
    return path.reverse();
  }
  function startTask(job) {
    const a = job.a;
    a.task = { id: job.id, label: job.doing, start: Date.now(), result: results.get(job.id) || null };
    results.delete(job.id);
    say(a, `${job.doing}…`, 'task', 120000);
  }
  function bossNext() {
    if (!boss.queue.length) {
      const p = bfs(boss.tile[0], boss.tile[1], 7, 14);
      boss.fromF = boss.floorNow; boss.toF = FI.atico;
      if (p && p.length) { boss.path = p; boss.pathLen0 = p.length; boss.state = 'returning'; }
      else { boss.state = 'seated'; boss.dir = 'down'; boss.floorNow = FI.atico; }
      return;
    }
    const job = boss.queue.shift();
    const p = bfs(boss.tile[0], boss.tile[1], job.a.stand[0], job.a.stand[1]);
    if (!p) { startTask(job); return bossNext(); }
    boss.job = job; boss.path = p; boss.pathLen0 = Math.max(1, p.length); boss.state = 'walking';
    boss.fromF = boss.floorNow; boss.toF = floorOf(job.a);
  }
  function bossTick(dt, now) {
    if (boss.state === 'seated') {
      if (now > boss.blinkAt) { boss.blink = true; if (now > boss.blinkAt + 130) { boss.blink = false; boss.blinkAt = now + rnd(2500, 5000); } }
      if (boss.queue.length) bossNext();
    } else if (boss.state === 'walking' || boss.state === 'returning') {
      let left = 7.5 * T * dt;
      while (left > 0 && boss.path.length) {
        const [tx, ty] = boss.path[0], gx = tx * T + 8, gy = ty * T + 13, dx = gx - boss.x, dy = gy - boss.y, d = Math.hypot(dx, dy);
        if (d > 0.01) boss.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        if (d <= left) { boss.x = gx; boss.y = gy; boss.tile = [tx, ty]; boss.path.shift(); left -= d; }
        else { boss.x += (dx / d) * left; boss.y += (dy / d) * left; left = 0; }
      }
      boss.frameT += dt; if (boss.frameT > 0.13) { boss.frameT = 0; boss.frame ^= 1; }
      if (!boss.path.length) {
        boss.floorNow = boss.toF;
        if (boss.state === 'walking') { boss.dir = 'up'; boss.state = 'handing'; boss.hand = { a: boss.job.a, start: now, dur: 420 }; }
        else { boss.state = 'seated'; boss.dir = 'down'; }
      }
    } else if (boss.state === 'handing' && now >= boss.hand.start + boss.hand.dur + 160) {
      const job = boss.job; boss.hand = null; boss.job = null;
      startTask(job);
      bossNext();
    }
    for (const p of bossPlates) p.hidden = boss.state !== 'seated';
  }
  function order(ev: OrderEvent) {
    const a = ev.serverId === RECEPTION_KEY ? RECEP : actors.find((x) => x.serverId === ev.serverId);
    if (ev.phase === 'start') {
      if (!a || (a !== RECEP && !a.online)) return;
      const job = { id: ev.id, a, doing: ev.doing };
      if (REDUCED) startTask(job); else boss.queue.push(job);
      return;
    }
    const res = { ok: ev.ok !== false, text: ev.result || (ev.ok === false ? 'No se pudo hacer' : 'Hecho') };
    if (a && a.task && a.task.id === ev.id) a.task.result = res; else results.set(ev.id, res);
  }

  /* --- Charla de cada empleado según sus datos --- */
  function chatter(a, now) {
    if (!a.online || a.task || now < a.nextChat) return;
    const alerts = [];
    if (a.cpu > THRESHOLDS.cpu) alerts.push([`¡Voy a tope! CPU al ${pct(a.cpu)}`, 'warn']);
    if (a.ram > THRESHOLDS.ram) alerts.push([`Me quedo sin memoria (${pct(a.ram)})`, 'warn']);
    if ((a.disk ?? 0) > THRESHOLDS.disk) alerts.push([`El archivo está a rebosar: disco al ${pct(a.disk)}`, 'warn']);
    for (const c of crashed(a)) alerts.push([`¡${c.name} está ${containerStateMeta(c).label.toLowerCase()}!`, 'bad']);
    const neighbor = actors.some((x) => x !== a && x.bubble && x.floor === a.floor && Math.abs(x.bx - a.bx) < 120);
    if (alerts.length) {
      if (neighbor && Math.random() < 0.5) { a.nextChat = now + 1500; return; }
      const [t, tone] = pick(alerts); say(a, t, tone, 4200); a.doing = t.replace(/^¡|!$/g, ''); a.nextChat = now + rnd(6500, 10000); return;
    }
    if (neighbor) { a.nextChat = now + rnd(1500, 3500); return; }
    const t = pickActivity(a); a.doing = t; say(a, t, '', 4200); a.nextChat = now + rnd(10000, 19000);
  }
  function recepChatter(now) {
    const R = RECEP; if (R.task || now < R.nextChat || !R.webs.length) return;
    const down = R.webs.filter((w) => w.down);
    if (down.length) { say(R, `¡${down[0].name} no contesta!`, 'bad', 3800); R.doing = `${down[0].name} no contesta`; R.nextChat = now + 5200; return; }
    const w = pick(R.webs);
    const t = Math.random() < 0.35 || w.latencyMs === null ? `Las ${R.webs.length} webs contestan` : `${w.name} contesta en ${Math.round(w.latencyMs)} ms`;
    say(R, t, '', 4000); R.doing = t; R.nextChat = now + rnd(12000, 20000);
  }
  function animate(a, dt, now, busy) {
    const A = a.anim;
    if (now > A.blinkAt) { A.blink = true; if (now > A.blinkAt + 130) { A.blink = false; A.blinkAt = now + rnd(2500, 5500); } }
    if (!a.task && busy < 0.3 && now > A.sipNext) { A.sipUntil = now + 1600; A.sipNext = now + rnd(9000, 17000); }
    A.sip = now < A.sipUntil;
    const typing = !A.sip && (a.task || busy > 0.5 || Math.sin((now / 1000) * 0.8 + (a.seed || 0)) > -0.2);
    if (!REDUCED && typing) A.phase += dt * (2.5 + busy * 11);
    const s1 = Math.sin(A.phase * Math.PI * 2);
    A.lo = typing && s1 > 0.2 ? 1 : 0; A.ro = typing && s1 < -0.2 ? 1 : 0;
    A.bob = !REDUCED && (busy > 0.78 || a.task) && A.lo ? -1 : 0;
    A.talk = !!(a.bubble && a.bubble.tone !== 'task' && Math.floor(now / 170) % 2);
    A.sweat = a.cpu > THRESHOLDS.cpu; A.sweatY = Math.floor(now / 200) % 4;
  }
  function update(dt, now) {
    for (const a of [...actors, RECEP]) {
      if (a.task) {
        const t = a.task, waited = now - t.start;
        if ((t.result && waited >= 900) || waited > 90000) {
          a.task = null;
          if (t.result) say(a, t.result.ok ? `Listo: ${t.result.text}` : t.result.text, t.result.ok ? '' : 'bad', 4200);
          else hush(a);
        } else if (a.bubble && a.bubble.tone === 'task') {
          const dots = '.'.repeat(1 + (Math.floor(now / 400) % 3));
          const text = `${t.label}${dots}`;
          if (a.bubbles[0] && a.bubbles[0].textContent !== text) for (const el of a.bubbles) el.textContent = text;
        }
      }
      if (a.bubble && now > a.bubble.until) hush(a);
    }
    for (const a of actors) {
      if (!a.online) continue;
      animate(a, dt, now, a.task ? 1 : clamp(a.cpu / 100, 0, 1));
      chatter(a, now);
      if (!REDUCED) {
        a.spawnAcc += dt * (0.3 + a.cpu / 35);
        while (a.spawnAcc >= 1) { a.spawnAcc -= 1; if (packets.length < 90) packets.push({ a, u: 0, dir: Math.random() < 0.62 ? 1 : -1, speed: rnd(60, 85) }); }
      }
    }
    animate(RECEP, dt, now, 0.25); recepChatter(now);
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i], P = p.a.paths[mode], prevU = p.u;
      p.u += (p.speed * dt) / P.len;
      if (p.u >= 1 || !p.a.inScene || (!p.a.online && p.u > 0.5)) { packets.splice(i, 1); continue; }
      if (P.dRouter > 0) {
        const r = P.dRouter / P.len, x = p.dir > 0 ? prevU : 1 - prevU, y = p.dir > 0 ? p.u : 1 - p.u;
        if ((x - r) * (y - r) <= 0) routerFlash[p.a.key] = now;
      }
    }
    bossTick(dt, now);
  }

  /* --- Bucle, tamaño y ratón --- */
  function resize() {
    const r = world.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    S = Math.max(1, Math.ceil((r.width * dpr) / W));
    if (canvas.width !== W * S) { canvas.width = W * S; canvas.height = H * S; }
  }
  const ro = new ResizeObserver(resize); ro.observe(world); resize();
  let last = performance.now(), raf = 0, plateTimer = 0;
  function frame(t) {
    if (destroyed) return;
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    const now = Date.now();
    update(dt, now);
    if (canvas.offsetParent !== null) render(now);
    plateTimer += dt; if (plateTimer > 1) { plateTimer = 0; refreshPlates(); }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  function hitTest(e) {
    const r = canvas.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    for (const a of [...actors, RECEP]) { const [hx, hy, hw, hh] = hitRect(a); if (x >= hx && x <= hx + hw && y >= hy && y <= hy + hh) return a; }
    return null;
  }
  const onClick = (e) => { const a = hitTest(e); if (a) o.onSelect(a.key); };
  const onMove = (e) => { const a = hitTest(e); hoverId = a ? a.key : null; canvas.style.cursor = a ? 'pointer' : 'default'; };
  const onLeave = () => { hoverId = null; };
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  function setMode(m: SceneMode, focusKey?: FloorKey) {
    mode = m; hoverId = null;
    overlays.oficina.hidden = m !== 'oficina'; overlays.edificio.hidden = m !== 'edificio';
    let cx = 320;
    if (focusKey && m === 'oficina') { const r = FLOORS[FI[focusKey]].room; cx = r[0] + r[2] / 2; focusRoom = { key: focusKey, until: Date.now() + 2400 }; }
    requestAnimationFrame(() => {
      const x = m === 'edificio' && !focusKey ? (118 / W) * world.clientWidth : (cx / W) * world.clientWidth - stageScroll.clientWidth / 2;
      stageScroll.scrollTo({ left: Math.max(0, x), behavior: REDUCED || !focusKey ? 'auto' : 'smooth' });
    });
  }

  return {
    setData,
    setMode,
    order,
    setSelected(key) { selected = key; refreshPlates(); },
    /** Lo que está haciendo ahora cada uno, para la plantilla. */
    doing(key) {
      const a = key === RECEPTION_KEY ? RECEP : byKey.get(key);
      if (!a) return '';
      if (a.task) return `${a.task.label}…`;
      return a.doing;
    },
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener('click', onClick); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave);
      overlays.oficina.innerHTML = ''; overlays.edificio.innerHTML = '';
    },
  };
}

export type Scene = ReturnType<typeof createScene>;
