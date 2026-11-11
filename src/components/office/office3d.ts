/*
 * Oficina en 3D (Three.js, estilo voxel).
 *
 * No piensa: la escena 2D (scene.ts) sigue siendo quien decide qué hace cada empleado, qué dice,
 * por dónde va el jefe con los encargos y si es de día o de noche. Aquí solo se lee su snapshot()
 * en cada fotograma y se dibuja el mismo plano (una baldosa de 16 px = una unidad) en volumen.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { THRESHOLDS } from '../../../shared/types';
import type { Look, Scene, SceneSnapshot, SnapshotActor } from './scene';
import { DESK_Y, MH, MW, NET_X, RACK_X, RECEPTION_KEY, SKIES, T, noteColor, tiles } from './scene';

export interface Office3DOptions {
  container: HTMLElement;
  overlay: HTMLElement;
  scene: Scene;
  onSelect: (key: string) => void;
}

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const u = (px: number) => px / T;

const TONE_HEX = { ok: 0x00ff9d, warn: 0xffcc00, bad: 0xff4d4d, info: 0x5a9cf0, idle: 0x6e737c };
const FLOOR_COLOR: Record<string, number> = {
  nube: 0x2a2640, casa: 0x203044, office: 0x3b2d22, hall: 0x26282f, door: 0x26282f, cpd: 0x2a2f3a, wall: 0x3a3e4a,
};
/** Luz según la hora: la misma paleta de cielos que usan las ventanas del 2D. */
const LIGHT = {
  day: { hemi: [0xa8d3f1, 0x6a645c, 2.6], sun: [0xfff2d2, 3.4, [-12, 22, 6]], lamps: 0.35, walls: 0x4b505e },
  dawn: { hemi: [0x7a7fb8, 0x5a4a40, 1.7], sun: [0xffb36b, 2.4, [34, 9, 4]], lamps: 0.7, walls: 0x3f4350 },
  dusk: { hemi: [0x6a5f9a, 0x5a4338, 1.6], sun: [0xff9a5c, 2.2, [-30, 8, 4]], lamps: 0.8, walls: 0x3d4150 },
  night: { hemi: [0x2a3460, 0x0a0c12, 0.95], sun: [0x8fa3ff, 0.6, [8, 24, -10]], lamps: 1.2, walls: 0x30343f },
} as const;

/* ---------- Piezas ---------- */
const geo = { box: new THREE.BoxGeometry(1, 1, 1) };
const matCache = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: number | string, opts: { emissive?: number | string; emissiveIntensity?: number } = {}) {
  const key = `${color}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    if (opts.emissive !== undefined) { m.emissive = new THREE.Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity ?? 1; }
    matCache.set(key, m);
  }
  return m;
}
function box(w: number, h: number, d: number, color: number | string, x = 0, y = 0, z = 0, m?: THREE.Material) {
  const mesh = new THREE.Mesh(geo.box, m ?? mat(color));
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
/** Caja con material propio (para cambiarle el color sin afectar a las demás). */
function ownBox(w: number, h: number, d: number, color: number | string, x = 0, y = 0, z = 0, emissive?: number | string) {
  const m = new THREE.MeshLambertMaterial({ color });
  if (emissive !== undefined) m.emissive = new THREE.Color(emissive);
  return box(w, h, d, color, x, y, z, m);
}

/* ---------- Personajes ---------- */
interface Person {
  group: THREE.Group;
  torso: THREE.Mesh; head: THREE.Group; armL: THREE.Mesh; armR: THREE.Mesh; legL: THREE.Mesh; legR: THREE.Mesh;
  eyes: THREE.Mesh[]; mouth: THREE.Mesh; mouthMat: THREE.Material; mug: THREE.Mesh; folder: THREE.Mesh; sweat: THREE.Mesh;
}
/** Figura voxel, de pie, mirando a +z. Alto ≈ 1,55 unidades. */
function makePerson(L: Look): Person {
  const g = new THREE.Group();
  const legL = ownBox(0.22, 0.55, 0.26, L.pants, -0.15, 0, 0), legR = ownBox(0.22, 0.55, 0.26, L.pants, 0.15, 0, 0);
  // Las piernas giran desde la cadera: se mueve el origen al tope.
  for (const leg of [legL, legR]) { leg.geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0); leg.position.y = 0.55; }
  const torso = ownBox(0.62, 0.62, 0.36, L.shirt, 0, 0.55, 0);
  const armL = ownBox(0.16, 0.5, 0.2, L.shirt, -0.4, 0.62, 0), armR = ownBox(0.16, 0.5, 0.2, L.shirt, 0.4, 0.62, 0);
  for (const arm of [armL, armR]) { arm.geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0); arm.position.y = 1.12; }
  const handL = box(0.17, 0.12, 0.22, L.skin, 0, -0.56, 0), handR = box(0.17, 0.12, 0.22, L.skin, 0, -0.56, 0);
  handL.scale.set(0.17 / 0.16, 0.12 / 0.5, 0.22 / 0.2); handR.scale.copy(handL.scale);
  handL.position.set(0, -1.05, 0); handR.position.set(0, -1.05, 0);
  armL.add(handL); armR.add(handR);
  const head = new THREE.Group();
  head.position.y = 1.22;
  head.add(box(0.52, 0.5, 0.48, L.skin, 0, 0, 0));
  // Peinados: una tapa de pelo y, según el estilo, melena, moño, puntas o barba.
  head.add(box(0.56, 0.16, 0.52, L.hair, 0, 0.42, 0));
  head.add(box(0.56, 0.24, 0.12, L.hair, 0, 0.26, -0.2));
  if (L.style === 'long') { head.add(box(0.1, 0.5, 0.5, L.hair, -0.3, -0.04, -0.02)); head.add(box(0.1, 0.5, 0.5, L.hair, 0.3, -0.04, -0.02)); }
  if (L.style === 'bun') head.add(box(0.24, 0.2, 0.22, L.hair, 0, 0.5, -0.14));
  if (L.style === 'spiky') for (const sx of [-0.18, 0, 0.18]) head.add(box(0.1, 0.16, 0.1, L.hair, sx, 0.56, 0));
  if (L.style === 'beard') head.add(box(0.5, 0.16, 0.1, L.hair, 0, 0.02, 0.22));
  const eyeM = mat(0x1a1420);
  const eyes = [-0.12, 0.12].map((ex) => { const e = box(0.07, 0.1, 0.04, 0x1a1420, ex, 0.14, 0.25, eyeM); e.castShadow = false; return e; });
  const mouth = box(0.14, 0.05, 0.04, L.skinD, 0, 0.02, 0.25);
  mouth.castShadow = false;
  head.add(...eyes, mouth);
  if (L.tie) torso.add(box(0.08 / 0.62, 0.4 / 0.62, 0.04 / 0.36, 0x00c97c, 0, 0.1 / 0.62, 0.2 / 0.36));
  const mug = box(0.2, 0.2, 0.2, 0xd8d4cc); mug.visible = false; mug.position.set(0.14, -1.02, 0.14); armR.add(mug);
  const folder = box(0.36, 0.44, 0.06, 0xe9d8a6); folder.visible = false; folder.position.set(0, -0.95, 0.2); armR.add(folder);
  const sweat = box(0.06, 0.1, 0.06, 0x8fd0ff, 0.3, 0.1, 0.1, mat(0x8fd0ff, { emissive: 0x8fd0ff, emissiveIntensity: 0.6 })); sweat.visible = false; head.add(sweat);
  g.add(legL, legR, torso, armL, armR, head);
  return { group: g, torso, head, armL, armR, legL, legR, eyes, mouth, mouthMat: mouth.material as THREE.Material, mug, folder, sweat };
}
function sitPose(p: Person) {
  p.legL.rotation.x = -Math.PI / 2; p.legR.rotation.x = -Math.PI / 2;
  p.legL.position.y = 0.5; p.legR.position.y = 0.5;
  p.group.position.y = 0.42;
  p.armL.rotation.x = -1.05; p.armR.rotation.x = -1.05;
}
function standPose(p: Person) {
  p.legL.rotation.x = 0; p.legR.rotation.x = 0; p.legL.position.y = 0.55; p.legR.position.y = 0.55;
  p.group.position.y = 0;
  p.armL.rotation.x = 0; p.armR.rotation.x = 0;
}
const DIR_ROT = { down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2 } as const;

/* ---------- Pantallas (texturas de canvas, como en el 2D) ---------- */
function canvasTexture(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
  return { c, g: c.getContext('2d')!, tex };
}
function screenPlane(w: number, h: number, tex: THREE.Texture) {
  const m = new THREE.MeshBasicMaterial({ map: tex });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  return mesh;
}
const rect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

/* ---------- Mobiliario ---------- */
function plant(x: number, z: number) {
  const g = new THREE.Group();
  g.add(box(0.5, 0.4, 0.5, 0x8a5a3c, 0, 0, 0));
  g.add(box(0.44, 0.5, 0.44, 0x2f7a4d, 0, 0.4, 0));
  g.add(box(0.3, 0.42, 0.3, 0x3d9661, 0.12, 0.8, 0.08));
  g.add(box(0.28, 0.36, 0.28, 0x2f7a4d, -0.16, 0.72, -0.06));
  g.position.set(x, 0.1, z);
  return g;
}
function deskGroup() {
  const g = new THREE.Group();
  g.add(box(3, 0.12, 1.3, 0x6e4b31, 0, 0.9, 0));
  for (const [sx, sz] of [[-1.4, -0.55], [1.4, -0.55], [-1.4, 0.55], [1.4, 0.55]]) g.add(box(0.1, 0.9, 0.1, 0x4d3322, sx, 0, sz));
  g.add(box(2.8, 0.5, 0.06, 0x4d3322, 0, 0.4, -0.6));
  return g;
}

/* ---------- Oficina ---------- */
export function createOffice3D(o: Office3DOptions) {
  const { container, overlay, scene: brain } = o;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = !COARSE;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.display = 'block';
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080a);
  scene.fog = new THREE.Fog(0x07080a, 46, 90);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(MW / 2 - 3, 19, MH + 12);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(MW / 2, 0.4, MH / 2 + 0.5);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.18; controls.minDistance = 7; controls.maxDistance = 64;
  controls.enablePan = true; controls.screenSpacePanning = false;
  controls.update();

  /* --- Luces --- */
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = !COARSE;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 16, bottom: -16, near: 1, far: 80 });
  sun.shadow.bias = -0.0008;
  sun.target.position.set(MW / 2, 0, MH / 2);
  scene.add(hemi, sun, sun.target);
  let skyNow: SceneSnapshot['sky'] | null = null;
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a3e4a });
  const windowMats: THREE.MeshBasicMaterial[] = [];
  const lamps: { light: THREE.PointLight; head: THREE.Mesh }[] = [];
  function applySky(sky: SceneSnapshot['sky']) {
    skyNow = sky;
    const P = LIGHT[sky], S = SKIES[sky];
    hemi.color.set(P.hemi[0]); hemi.groundColor.set(P.hemi[1]); hemi.intensity = P.hemi[2];
    sun.color.set(P.sun[0]); sun.intensity = P.sun[1]; sun.position.set(MW / 2 + P.sun[2][0], P.sun[2][1], MH / 2 + P.sun[2][2]);
    wallMat.color.set(P.walls);
    for (const m of windowMats) m.color.set(S.pane);
    (scene.background as THREE.Color).set(sky === 'day' ? 0x111a24 : sky === 'night' ? 0x05060a : 0x120e16);
    (scene.fog as THREE.Fog).color.copy(scene.background as THREE.Color);
    for (const l of lamps) l.light.intensity = l.light.userData.on ? 7 * P.lamps : 0;
  }

  /* --- Suelo y paredes a partir del plano por baldosas --- */
  const floorTiles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), MW * MH);
  floorTiles.receiveShadow = true;
  const wallList: [number, number][] = [];
  {
    const m = new THREE.Matrix4(), col = new THREE.Color();
    let n = 0;
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const t = tiles[y][x];
      if (t === 'wall') {
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tiles[y + dy]?.[x + dx] && tiles[y + dy][x + dx] !== 'wall');
        if (near) wallList.push([x, y]);
        continue;
      }
      col.set(FLOOR_COLOR[t]);
      // Pequeña variación por baldosa para que el suelo no sea plano.
      col.offsetHSL(0, 0, ((x * 7 + y * 13) % 5) * 0.006 - 0.012);
      m.makeTranslation(x + 0.5, -0.06, y + 0.5);
      floorTiles.setMatrixAt(n, m); floorTiles.setColorAt(n, col); n++;
    }
    floorTiles.count = n;
    floorTiles.instanceMatrix.needsUpdate = true;
    if (floorTiles.instanceColor) floorTiles.instanceColor.needsUpdate = true;
  }
  scene.add(floorTiles);
  const WALL_H = 2.6;
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), wallMat, wallList.length);
  walls.castShadow = true; walls.receiveShadow = true;
  {
    const m = new THREE.Matrix4();
    wallList.forEach(([x, y], i) => { m.makeTranslation(x + 0.5, WALL_H / 2, y + 0.5); walls.setMatrixAt(i, m); });
    walls.instanceMatrix.needsUpdate = true;
  }
  scene.add(walls);
  // Zócalo oscuro alrededor de todo el plano, para que el borde no quede cortado en seco.
  scene.add(box(MW + 6, 0.5, MH + 6, 0x0c0d11, MW / 2, -0.62, MH / 2));

  /* --- Ventanas al exterior y puerta de entrada (pared norte) --- */
  function windowPane(x: number, z: number, w: number, h: number, y: number, rotY = 0) {
    const m = new THREE.MeshBasicMaterial({ color: 0x5f9fd6 });
    windowMats.push(m);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    pane.position.set(x, y, z); pane.rotation.y = rotY;
    scene.add(pane);
    const frame = box(w + 0.16, h + 0.16, 0.06, 0x16181e, x, y - h / 2 - 0.08, z - 0.04);
    frame.castShadow = false; frame.rotation.y = rotY;
    scene.add(frame);
    for (const fx of [-w / 4, 0, w / 4]) { const bar = box(0.05, h, 0.03, 0x1a1f2c, x + fx, y - h / 2, z + 0.005); bar.castShadow = false; scene.add(bar); }
  }
  windowPane(u(112 + 16), 2.01, 2, 1.1, 1.8);
  windowPane(u(262 + 16), 2.01, 2, 1.1, 1.8);
  windowPane(u(320), 2.01, 2.2, 1.9, 1.05);
  for (const x of [4.5, 11.5, 29, 35.5]) windowPane(x, 2.01, 1.6, 1, 1.75);
  // Letrero de la empresa sobre la entrada.
  const logo = box(1, 1, 0.1, 0x00c97c, u(346) + 0.5, 1.3, 2.02, mat(0x00c97c, { emissive: 0x00c97c, emissiveIntensity: 0.5 }));
  logo.castShadow = false; scene.add(logo);

  /* --- Mobiliario fijo --- */
  for (const [px, py] of [[24, 63], [232, 63], [264, 47], [376, 47], [216, 207], [216, 335], [408, 63], [616, 191]]) scene.add(plant(u(px), u(py) - 0.3));
  // Sala de reuniones de la nube: mesa y cuatro sillas.
  scene.add(box(3.2, 0.1, 1.1, 0x5c4030, u(112), 0.8, u(140)));
  for (const [sx, sz] of [[-1.5, -0.45], [1.5, -0.45], [-1.5, 0.45], [1.5, 0.45]]) { scene.add(box(0.1, 0.8, 0.1, 0x3f2b1f, u(112) + sx * 0.9, 0, u(140) + sz)); }
  for (const sx of [-0.9, 0.9]) for (const sz of [-1.1, 1.1]) scene.add(box(0.5, 0.5, 0.5, 0x2a2d36, u(112) + sx, 0, u(140) + sz));
  // Despacho: alfombra, estantería y sofá.
  const rug = box(4.5, 0.03, 3.6, 0x33263d, u(120), -0.01, u(251)); rug.castShadow = false; scene.add(rug);
  scene.add(box(1.8, 2.2, 0.5, 0x3d2b1f, u(34), 0, u(192) + 0.3));
  for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) scene.add(box(0.18, 0.4, 0.32, [0x7c6cf0, 0x3fa7c9, 0xc24d78, 0xe08a3c, 0x6b7fa6, 0x2f7a4d][(i * 6 + k) % 6], u(34) - 0.7 + k * 0.26, 0.2 + i * 0.68, u(192) + 0.3));
  scene.add(box(3.5, 0.55, 1.1, 0x3b3550, u(558), 0, u(171)));
  scene.add(box(3.5, 0.5, 0.3, 0x4a4363, u(558), 0.55, u(171) - 0.4));
  // Aire acondicionado del CPD y extintor.
  const ac = box(2.6, 0.7, 0.5, 0xc9ccd3, u(588), 1.8, u(200)); scene.add(ac);
  scene.add(box(0.3, 0.9, 0.3, 0xc43c3c, u(408), 0, u(308)));

  /* --- Mesas de los empleados --- */
  interface DeskRig {
    key: string; group: THREE.Group; person: Person; chair: THREE.Mesh; lamp: { light: THREE.PointLight; head: THREE.Mesh };
    papers: THREE.Mesh; mug: THREE.Mesh; led: THREE.Mesh; monitorScreen: THREE.Mesh;
    wall: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D; c: HTMLCanvasElement }; cork: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D; c: HTMLCanvasElement };
    wallMesh: THREE.Mesh; corkMesh: THREE.Mesh; hit: THREE.Mesh; ring: THREE.Mesh; cable: THREE.Line | null;
    plate: HTMLButtonElement; bubble: HTMLDivElement; lastWall: string; lastCork: string;
  }
  const rigs = new Map<string, DeskRig>();
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const ringGeo = new THREE.RingGeometry(1.1, 1.3, 32).rotateX(-Math.PI / 2);
  const cableMat = new THREE.LineBasicMaterial({ color: 0x2e323d });

  function makePlate(title: string, key: string) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sc-plate';
    b.innerHTML = `<span class="sc-dot"></span>${title.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)}`;
    b.setAttribute('aria-label', `Ver la ficha de ${title}`);
    b.addEventListener('click', () => o.onSelect(key));
    overlay.append(b);
    return b;
  }
  function makeBubble() {
    const d = document.createElement('div');
    d.className = 'sc-bubble'; d.setAttribute('aria-hidden', 'true');
    overlay.append(d);
    return d;
  }

  function buildDesk(a: SnapshotActor): DeskRig {
    const g = new THREE.Group();
    const cx = u(a.cx), dz = u(DESK_Y) + 0.7;
    g.position.set(cx, 0, 0);
    g.add(deskGroup().translateZ(dz));
    const chair = box(0.9, 0.5, 0.9, 0x2a2d36, 0, 0, dz - 1.25);
    g.add(chair, box(0.9, 0.9, 0.12, 0x383c48, 0, 0.5, dz - 1.7));
    const person = makePerson(a.look);
    person.group.position.set(0, 0.42, dz - 1.2);
    sitPose(person);
    g.add(person.group);
    // Monitor con su luz de estado, teclado, flexo, taza y papeles.
    const monitorScreen = ownBox(0.9, 0.7, 0.06, 0x0b1a14, 0.75, 1.3, dz + 0.05, 0x0b1a14);
    g.add(box(1, 0.8, 0.1, 0x1c1e25, 0.75, 1.25, dz), monitorScreen, box(0.3, 0.25, 0.3, 0x1c1e25, 0.75, 1.02, dz));
    const led = ownBox(0.1, 0.1, 0.04, 0x5a9cf0, 1.1, 1.08, dz + 0.06, 0x5a9cf0);
    g.add(led);
    g.add(box(0.9, 0.06, 0.32, 0x3a3d47, 0, 1.02, dz - 0.25));
    const lampHead = ownBox(0.42, 0.18, 0.3, 0xd6cfb2, -1.2, 1.55, dz + 0.1, 0xffe0a0);
    const light = new THREE.PointLight(0xffc478, 0, 4.5, 1.6);
    light.position.set(-1.1, 1.5, dz); light.castShadow = false; light.userData.on = false;
    g.add(box(0.08, 0.6, 0.08, 0x555a66, -1.2, 1.02, dz + 0.2), lampHead, light);
    const lamp = { light, head: lampHead }; lamps.push(lamp);
    const papers = ownBox(0.5, 0.1, 0.6, 0xe8e4da, -1.1, 1.02, dz - 0.3);
    const mug = box(0.22, 0.24, 0.22, 0xd8d4cc, -0.6, 1.02, dz - 0.2);
    g.add(papers, mug);
    // Pantalla de la pared y corcho con una nota por contenedor.
    const wall = canvasTexture(56, 44), cork = canvasTexture(30, 32);
    const wallMesh = screenPlane(1.75, 1.35, wall.tex); wallMesh.position.set(-0.55, 1.75, 2.015); g.add(wallMesh);
    g.add(box(1.9, 1.5, 0.05, 0x0c0d11, -0.55, 1.0, 2.0));
    const corkMesh = screenPlane(0.95, 1.0, cork.tex); corkMesh.position.set(0.95, 1.75, 2.015); g.add(corkMesh);
    g.add(box(1.05, 1.1, 0.05, 0x5b412b, 0.95, 1.2, 2.0));
    const hit = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 3.4), hitMat);
    hit.position.set(0, 1.3, dz - 0.5); hit.userData.key = a.key; g.add(hit);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x00ff9d, transparent: true, opacity: 0 }));
    ring.position.set(0, 0.02, dz - 0.9); g.add(ring);
    let cable: THREE.Line | null = null;
    if (a.cable.length) {
      const pts = a.cable.map(([px, py]) => new THREE.Vector3(u(px), 0.03, u(py)));
      cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat);
      scene.add(cable);
    }
    scene.add(g);
    const rig: DeskRig = {
      key: a.key, group: g, person, chair, lamp, papers, mug, led, monitorScreen, wall, cork, wallMesh, corkMesh, hit, ring, cable,
      plate: makePlate(a.title, a.key), bubble: makeBubble(), lastWall: '', lastCork: '',
    };
    return rig;
  }
  function dropDesk(r: DeskRig) {
    scene.remove(r.group); if (r.cable) scene.remove(r.cable);
    r.plate.remove(); r.bubble.remove();
    lamps.splice(lamps.indexOf(r.lamp), 1);
  }

  function paintWall(r: DeskRig, a: SnapshotActor, now: number) {
    const { g, c, tex } = r.wall, w = c.width, h = c.height;
    const sig = a.online ? (a.task ? `t${Math.round(a.task.progress * 20)}${a.task.done}` : `${a.tone}|${Math.round(a.cpu)}|${Math.round(a.ram)}|${Math.round(a.disk ?? 0)}|${a.hist.length ? a.hist[a.hist.length - 1] : ''}`) : `off${Math.floor(now / 120) % 7}`;
    if (sig === r.lastWall) return;
    r.lastWall = sig;
    if (!a.online) {
      rect(g, 0, 0, w, h, '#0b0c0f');
      if (!REDUCED) for (let i = 0; i < 30; i++) rect(g, Math.floor(Math.random() * w), Math.floor(Math.random() * h), 2, 2, Math.random() < 0.5 ? '#2a2d36' : '#3a3e4a');
    } else if (a.task) {
      rect(g, 0, 0, w, h, '#07140f');
      rect(g, 6, 14, w - 12, 8, '#132520'); rect(g, 6, 14, Math.round((w - 12) * a.task.progress), 8, '#00ff9d');
      for (let k = 0; k < 3; k++) if (Math.floor(now / 250) % 3 >= k) rect(g, 6 + k * 7, 28, 4, 4, '#00ff9d');
    } else {
      rect(g, 0, 0, w, h, a.tone === 'bad' ? '#1a0b0d' : '#07140f');
      const vals = [a.cpu, a.ram, a.disk ?? 0], lim = [THRESHOLDS.cpu, THRESHOLDS.ram, THRESHOLDS.disk];
      vals.forEach((v, i) => { const y = 5 + i * 7; rect(g, 5, y, w - 10, 4, '#132520'); rect(g, 5, y, Math.max(2, Math.round(((w - 10) * v) / 100)), 4, v > lim[i] ? '#ffcc00' : '#00ff9d'); });
      a.hist.slice(-24).forEach((v, k) => { const hh = Math.max(1, Math.round((v / 100) * 10)); rect(g, 5 + k * 2, h - 4 - hh, 2, hh, '#2f6fb8'); });
    }
    tex.needsUpdate = true;
  }
  function paintCork(r: DeskRig, a: SnapshotActor, now: number) {
    const { g, c, tex } = r.cork;
    const sig = a.containers.slice(0, 9).map((x) => noteColor(x, now)).join(',') + a.online;
    if (sig === r.lastCork) return;
    r.lastCork = sig;
    rect(g, 0, 0, c.width, c.height, '#8c6744');
    a.containers.slice(0, 9).forEach((x, i) => {
      const nx = 3 + (i % 3) * 9, ny = 3 + Math.floor(i / 3) * 10, col = noteColor(x, now);
      rect(g, nx, ny, 7, 8, a.online ? col : '#3a3a3a'); rect(g, nx + 3, ny, 1, 1, 'rgba(0,0,0,.5)');
    });
    tex.needsUpdate = true;
  }

  /* --- Recepción --- */
  const RX = u(320), RZ = u(146) + 0.6;
  const recep = (() => {
    const g = new THREE.Group();
    g.add(box(4, 0.95, 0.9, 0x4b505e, RX, 0, RZ));
    g.add(box(4, 0.06, 1.1, 0x5d6373, RX, 0.95, RZ));
    const strip = box(4, 0.06, 0.04, 0x5a9cf0, RX, 0.6, RZ - 0.47, mat(0x5a9cf0, { emissive: 0x5a9cf0, emissiveIntensity: 0.8 })); strip.castShadow = false; g.add(strip);
    g.add(box(0.4, 0.4, 0.05, 0x00c97c, RX, 0.3, RZ + 0.46, mat(0x00c97c, { emissive: 0x00c97c, emissiveIntensity: 0.4 })));
    const chair = box(0.9, 0.5, 0.9, 0x2a2d36, RX, 0, RZ - 1.35); g.add(chair, box(0.9, 0.9, 0.12, 0x383c48, RX, 0.5, RZ - 1.8));
    const person = makePerson(brain.snapshot().reception.look);
    person.group.position.set(RX, 0.42, RZ - 1.3); sitPose(person); g.add(person.group);
    g.add(box(0.9, 0.06, 0.3, 0x3a3d47, RX, 1.01, RZ - 0.2));
    const phones = [-1.4, -0.9, 0.9, 1.4].map((dx) => {
      const base = ownBox(0.36, 0.16, 0.3, 0x1b1d23, RX + dx, 1.01, RZ + 0.1);
      const handset = ownBox(0.36, 0.1, 0.12, 0x2c2f39, RX + dx, 1.17, RZ + 0.1);
      const led = ownBox(0.06, 0.06, 0.06, 0x00ff9d, RX + dx + 0.12, 1.17, RZ + 0.2, 0x00ff9d);
      base.visible = handset.visible = led.visible = false;
      g.add(base, handset, led);
      return { base, handset, led };
    });
    const hit = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.4, 3), hitMat);
    hit.position.set(RX, 1.2, RZ - 0.6); hit.userData.key = RECEPTION_KEY; g.add(hit);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x00ff9d, transparent: true, opacity: 0 }));
    ring.position.set(RX, 0.02, RZ - 1); g.add(ring);
    scene.add(g);
    return { g, person, phones, hit, ring, plate: makePlate('Recepción', RECEPTION_KEY), bubble: makeBubble() };
  })();

  /* --- Despacho del jefe (tú) --- */
  const BX = u(120), BZ = u(242) + 0.7;
  const bossRig = (() => {
    const g = new THREE.Group();
    const desk = deskGroup(); desk.scale.set(1.18, 1, 1); desk.position.set(BX, 0, BZ); g.add(desk);
    g.add(box(1, 0.55, 1, 0x1b1d24, BX, 0, BZ - 1.3), box(1, 1.1, 0.14, 0x2a2d36, BX, 0.55, BZ - 1.8));
    g.add(box(1.1, 0.85, 0.1, 0x1c1e25, BX + 0.9, 1.25, BZ), ownBox(1, 0.75, 0.06, 0x0b1a14, BX + 0.9, 1.3, BZ + 0.05, 0x0b1a14));
    g.add(box(0.9, 0.06, 0.32, 0x3a3d47, BX, 1.02, BZ - 0.25));
    const lampHead = ownBox(0.5, 0.2, 0.3, 0x1f6b4a, BX - 1.4, 1.55, BZ + 0.1, 0xffe0a0);
    const light = new THREE.PointLight(0xffd79a, 0, 4.5, 1.6); light.position.set(BX - 1.3, 1.5, BZ); light.userData.on = true;
    g.add(lampHead, light); lamps.push({ light, head: lampHead });
    const papers = ownBox(0.5, 0.1, 0.6, 0xe8e4da, BX - 0.8, 1.02, BZ - 0.3); g.add(papers);
    // Televisor con una luz por empleado.
    const tv = canvasTexture(28, 10);
    const tvMesh = screenPlane(1.9, 0.7, tv.tex); tvMesh.position.set(u(190), 1.8, u(192) + 0.015); tvMesh.rotation.y = 0; g.add(tvMesh);
    g.add(box(2.05, 0.85, 0.05, 0x151821, u(190), 1.37, u(192)));
    const person = makePerson(brain.snapshot().boss.look);
    person.group.position.set(BX, 0.42, BZ - 1.25); sitPose(person); g.add(person.group);
    const walker = makePerson(brain.snapshot().boss.look); walker.group.visible = false; g.add(walker.group);
    const plate = document.createElement('div'); plate.className = 'sc-plate sc-static'; plate.textContent = 'Tú'; overlay.append(plate);
    scene.add(g);
    return { g, person, walker, papers, plate, tv, lastTv: '' };
  })();

  /* --- CPD: racks y equipo de red --- */
  const racks = RACK_X.map((px, i) => {
    const x = u(px) + 0.75, z = u(210) + 1.1;
    const g = new THREE.Group();
    g.add(box(1.5, 3, 0.95, 0x121419, x, 0, z), box(1.5, 0.1, 0.95, 0x3a3e4a, x, 3, z));
    const leds: THREE.Mesh[][] = [];
    for (let k = 0; k < 6; k++) {
      g.add(box(1.2, 0.34, 0.06, i === 2 && k > 2 ? 0x23262e : 0x1d2027, x, 0.3 + k * 0.42, z + 0.46));
      const row = [ownBox(0.08, 0.08, 0.04, 0x262a33, x - 0.45, 0.43 + k * 0.42, z + 0.5), ownBox(0.08, 0.08, 0.04, 0x262a33, x + 0.45, 0.43 + k * 0.42, z + 0.5)];
      g.add(...row); leds.push(row);
    }
    scene.add(g);
    return { g, leds };
  });
  const netRigs: { g: THREE.Group; led: THREE.Mesh; wan: THREE.Mesh; plate: HTMLDivElement; x: number; z: number }[] = [];
  let netSig = '';
  function buildNet(net: SceneSnapshot['net']) {
    const sig = JSON.stringify(net.map((d) => d.title + d.kind + d.detail));
    if (sig === netSig) return;
    netSig = sig;
    for (const r of netRigs) { scene.remove(r.g); r.plate.remove(); }
    netRigs.length = 0;
    net.slice(0, NET_X.length).forEach((d, i) => {
      const x = u(NET_X[i]), z = u(276), g = new THREE.Group();
      g.add(box(1, 0.3, 0.5, 0x5c4030, x, 0, z));
      if (d.kind === 'router') { g.add(box(2, 0.5, 1, 0x3a3f4c, x, 0.3, z), box(0.06, 0.8, 0.06, 0x2a2d36, x - 0.7, 0.8, z - 0.3), box(0.06, 0.8, 0.06, 0x2a2d36, x + 0.7, 0.8, z - 0.3)); }
      else if (d.kind === 'firewall') { g.add(box(1.8, 0.6, 0.9, 0x4a2f2a, x, 0.3, z), box(1.6, 0.06, 0.04, 0xe08a3c, x, 0.7, z + 0.45)); }
      else g.add(box(1.6, 0.6, 0.9, 0x3a3e4a, x, 0.3, z));
      const led = ownBox(0.12, 0.12, 0.05, 0x00ff9d, x - 0.5, 0.55, z + 0.5, 0x00ff9d);
      const wan = ownBox(0.1, 0.1, 0.05, 0x5a9cf0, x + 0.5, 0.55, z + 0.5, 0x5a9cf0);
      g.add(led, wan); scene.add(g);
      const plate = document.createElement('div'); plate.className = 'sc-plate sc-static';
      plate.textContent = d.title + (net.length === 1 && d.detail ? ` · ${d.detail}` : ''); overlay.append(plate);
      netRigs.push({ g, led, wan, plate, x, z });
    });
  }

  /* --- Paquetes de datos por los cables --- */
  const packetMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: 0x8fc4ff }), 90);
  packetMesh.count = 0; scene.add(packetMesh);

  /* --- Carteles fijos de las salas --- */
  const roomLabels = [
    ['Planta 2 · Nube', 8, 0, 10.2], ['Planta 1 · Casa', 32, 0, 10.2], ['Planta 1 · CPD', 32, 0, 20.2], ['Ático · Despacho', 8, 0, 20.2],
  ].map(([text, x, y, z]) => {
    const el = document.createElement('div'); el.className = 'sc-room'; el.style.transform = 'translate(-50%, -50%)'; el.textContent = text as string;
    overlay.append(el); return { el, p: new THREE.Vector3(x as number, y as number, z as number) };
  });
  const company = document.createElement('div'); company.className = 'sc-company';
  company.innerHTML = '<b>marcogugliandolo.com</b><span>Planta baja · Recepción</span>'; overlay.append(company);

  /* --- Proyección de etiquetas HTML sobre la escena --- */
  const v = new THREE.Vector3();
  let vw = 1, vh = 1;
  function place(el: HTMLElement, x: number, y: number, z: number) {
    v.set(x, y, z).project(camera);
    const behind = v.z > 1;
    el.style.display = behind ? 'none' : '';
    if (behind) return;
    el.style.left = `${((v.x + 1) / 2) * vw}px`; el.style.top = `${((1 - v.y) / 2) * vh}px`;
  }
  function setBubble(el: HTMLDivElement, b: { text: string; tone: string } | null) {
    if (!b) { if (el.classList.contains('sc-show')) el.classList.remove('sc-show'); return; }
    if (el.textContent !== b.text) el.textContent = b.text;
    if (el.dataset.tone !== b.tone) el.dataset.tone = b.tone;
    if (!el.classList.contains('sc-show')) el.classList.add('sc-show');
  }

  /* --- Fotograma --- */
  let selected: string | null = null, hoverKey: string | null = null, destroyed = false;
  const tmpM = new THREE.Matrix4();
  function posePerson(p: Person, A: SnapshotActor['anim'], online: boolean, now: number) {
    p.group.visible = online;
    if (!online) return;
    p.armL.rotation.x = -1.05 + (A.sip ? 0 : A.lo * -0.25); p.armR.rotation.x = A.sip ? -2.1 : -1.05 + A.ro * -0.25;
    p.mug.visible = A.sip;
    p.torso.position.y = 0.55 + 0.31 + A.bob * 0.05; p.head.position.y = 1.22 + A.bob * 0.05;
    for (const e of p.eyes) e.scale.y = A.blink ? 0.02 : 0.1;
    p.mouth.scale.y = A.talk ? 0.12 : 0.05; p.mouth.material = A.talk ? mat(0x7a3a2e) : p.mouthMat;
    p.sweat.visible = A.sweat; p.sweat.position.y = 0.2 - A.sweatY * 0.06;
    void now;
  }

  function frame(now: number) {
    const snap = brain.snapshot();
    if (snap.sky !== skyNow) applySky(snap.sky);
    buildNet(snap.net);
    // Mesas: crear las nuevas, quitar las que se fueron.
    const keys = new Set(snap.actors.map((a) => a.key));
    for (const [k, r] of rigs) if (!keys.has(k)) { dropDesk(r); rigs.delete(k); }
    for (const a of snap.actors) {
      let r = rigs.get(a.key);
      if (!r) { r = buildDesk(a); rigs.set(a.key, r); }
      else if (Math.abs(r.group.position.x - u(a.cx)) > 0.01) { dropDesk(r); r = buildDesk(a); rigs.set(a.key, r); }
      posePerson(r.person, a.anim, a.online, now);
      r.chair.position.z = r.person.group.position.z - 0.05 + (a.online ? 0 : 0.25);
      r.lamp.light.userData.on = a.online;
      r.lamp.light.intensity = a.online ? 7 * LIGHT[snap.sky].lamps : 0;
      (r.lamp.head.material as THREE.MeshLambertMaterial).emissiveIntensity = a.online ? 0.9 : 0;
      const pages = a.online ? 1 + Math.round(a.ram / 22) : 2;
      r.papers.scale.y = 0.08 * pages; r.papers.position.y = 1.02 + r.papers.scale.y / 2;
      r.mug.visible = !a.anim.sip || !a.online;
      const ledColor = !a.online ? 0x2a2d36 : a.task ? 0x00ff9d : a.tone === 'ok' ? 0x5a9cf0 : TONE_HEX[a.tone];
      (r.led.material as THREE.MeshLambertMaterial).emissive.set(ledColor); (r.led.material as THREE.MeshLambertMaterial).color.set(ledColor);
      (r.monitorScreen.material as THREE.MeshLambertMaterial).emissive.set(!a.online ? 0x000000 : a.tone === 'bad' ? 0x3a1015 : 0x0e3a28);
      paintWall(r, a, now); paintCork(r, a, now);
      const ringM = r.ring.material as THREE.MeshBasicMaterial;
      if (selected === a.key) { ringM.color.set(0x00ff9d); ringM.opacity = REDUCED ? 0.8 : 0.55 + 0.35 * Math.sin(now / 250); }
      else if (hoverKey === a.key) { ringM.color.set(0xffffff); ringM.opacity = 0.35; }
      else ringM.opacity = 0;
      r.plate.firstElementChild!.className = 'sc-dot sc-' + (!a.online ? 'idle' : a.tone);
      r.plate.setAttribute('aria-pressed', String(selected === a.key));
      place(r.plate, r.group.position.x, 2.75, u(DESK_Y) + 0.5);
      place(r.bubble, r.group.position.x, 3.2, u(DESK_Y) - 0.5);
      setBubble(r.bubble, a.bubble);
    }
    // Recepción.
    const R = snap.reception;
    posePerson(recep.person, R.anim, true, now);
    recep.phones.forEach((ph, i) => {
      const w = R.webs[i];
      ph.base.visible = ph.handset.visible = ph.led.visible = Boolean(w);
      if (!w) return;
      const ring = w.down && !REDUCED && Math.floor(now / 160) % 2;
      ph.handset.position.y = 1.22 + (ring ? 0.1 : 0);
      const c = w.down ? (Math.floor(now / 300) % 2 ? 0xff4d4d : 0x5a1a1a) : 0x00ff9d;
      (ph.led.material as THREE.MeshLambertMaterial).emissive.set(c); (ph.led.material as THREE.MeshLambertMaterial).color.set(c);
    });
    const rDown = R.webs.some((w) => w.down);
    recep.plate.firstElementChild!.className = 'sc-dot sc-' + (rDown ? 'bad' : 'ok');
    recep.plate.setAttribute('aria-pressed', String(selected === RECEPTION_KEY));
    const rr = recep.ring.material as THREE.MeshBasicMaterial;
    if (selected === RECEPTION_KEY) { rr.color.set(0x00ff9d); rr.opacity = REDUCED ? 0.8 : 0.55 + 0.35 * Math.sin(now / 250); }
    else if (hoverKey === RECEPTION_KEY) { rr.color.set(0xffffff); rr.opacity = 0.35; }
    else rr.opacity = 0;
    place(recep.plate, RX, 2.5, RZ - 0.4); place(recep.bubble, RX, 2.95, RZ - 1.3); setBubble(recep.bubble, R.bubble);
    place(company, RX, 0.05, RZ + 2.2);
    // Jefe: sentado en el despacho o andando con la carpeta.
    const B = snap.boss;
    const seated = B.state === 'seated';
    bossRig.person.group.visible = seated;
    bossRig.walker.group.visible = !seated;
    bossRig.plate.hidden = !seated;
    if (seated) { for (const e of bossRig.person.eyes) e.scale.y = B.blink ? 0.02 : 0.1; bossRig.person.armL.rotation.x = -1.05 - (Math.floor(now / 900) % 2) * 0.2; bossRig.person.armR.rotation.x = -1.05 - (Math.floor(now / 900 + 0.5) % 2) * 0.2; }
    else {
      const wk = bossRig.walker;
      standPose(wk);
      wk.group.position.set(u(B.x), 0, u(B.y));
      wk.group.rotation.y = DIR_ROT[B.dir];
      const moving = B.state === 'walking' || B.state === 'returning', swing = moving ? (B.frame ? 0.55 : -0.55) : 0;
      wk.legL.rotation.x = swing; wk.legR.rotation.x = -swing;
      wk.armL.rotation.x = -swing * 0.6; wk.armR.rotation.x = B.carrying ? -1.4 : swing * 0.6;
      wk.folder.visible = B.carrying;
      if (B.state === 'handing') { wk.armR.rotation.x = -1.6 + Math.min(0.6, (now % 600) / 1000); }
    }
    const pages = B.pending + 1;
    bossRig.papers.scale.y = 0.08 * pages; bossRig.papers.position.y = 1.02 + bossRig.papers.scale.y / 2;
    place(bossRig.plate, BX, 2.6, BZ - 0.3);
    const tvSig = [...snap.actors.map((a) => a.tone), rDown ? 'bad' : 'ok'].join(',');
    if (tvSig !== bossRig.lastTv) {
      bossRig.lastTv = tvSig;
      const { g, c, tex } = bossRig.tv; rect(g, 0, 0, c.width, c.height, '#07140f');
      [...snap.actors.map((a) => a.tone), rDown ? 'bad' : 'ok'].slice(0, 6).forEach((t, i) => rect(g, 3 + i * 4, 3, 3, 3, t === 'ok' ? '#00ff9d' : t === 'warn' ? '#ffcc00' : '#ff4d4d'));
      tex.needsUpdate = true;
    }
    // CPD: racks con una luz por equipo de casa y el router.
    const casa = snap.actors.filter((a) => a.floor === 'casa');
    racks.forEach((rk, ri) => rk.leds.forEach((row, k) => {
      const a = ri === 1 ? casa[k] : ri === 0 ? casa[k] : undefined;
      const on = Boolean(a);
      const c0 = !a ? 0x262a33 : a.online ? TONE_HEX[a.tone] : 0x3a1414;
      const c1 = !a ? 0x262a33 : !a.online ? 0x4a1a1a : now - a.routerFlash < 110 ? 0xffffff : 0x00ff9d;
      (row[0].material as THREE.MeshLambertMaterial).emissive.set(on ? c0 : 0x000000); (row[0].material as THREE.MeshLambertMaterial).color.set(c0);
      (row[1].material as THREE.MeshLambertMaterial).emissive.set(on ? c1 : 0x000000); (row[1].material as THREE.MeshLambertMaterial).color.set(c1);
      if (ri === 2) { const c = k === 5 ? (Math.floor(now / 2000) % 2 ? 0x00ff9d : 0x0f3a26) : 0x262a33; (row[0].material as THREE.MeshLambertMaterial).emissive.set(c); (row[1].material as THREE.MeshLambertMaterial).emissive.set(0x000000); }
    }));
    netRigs.forEach((n, i) => {
      const flash = casa.some((a) => now - a.routerFlash < 110);
      const c = i === 0 && flash ? 0xffffff : 0x00ff9d;
      (n.led.material as THREE.MeshLambertMaterial).emissive.set(c);
      (n.wan.material as THREE.MeshLambertMaterial).emissive.set(Math.floor(now / 400) % 2 ? 0x5a9cf0 : 0x1d3555);
      place(n.plate, n.x, 1.4, n.z + 0.6);
    });
    // Paquetes.
    const pk = REDUCED ? [] : snap.packets;
    packetMesh.count = Math.min(pk.length, 90);
    pk.slice(0, 90).forEach(([px, py], i) => { tmpM.makeTranslation(u(px), 0.12, u(py)); packetMesh.setMatrixAt(i, tmpM); });
    packetMesh.instanceMatrix.needsUpdate = true;
    for (const l of roomLabels) place(l.el, l.p.x, l.p.y, l.p.z);

    controls.update();
    renderer.render(scene, camera);
  }

  /* --- Tamaño, ratón y bucle --- */
  function resize() {
    const r = container.getBoundingClientRect();
    vw = Math.max(1, r.width); vh = Math.max(1, r.height);
    renderer.setSize(vw, vh, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = vw / vh; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt: [number, number] | null = null;
  function hitAt(e: PointerEvent | MouseEvent): string | null {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...[...rigs.values()].map((x) => x.hit), recep.hit], false);
    return hits.length ? (hits[0].object.userData.key as string) : null;
  }
  const onMove = (e: PointerEvent) => { hoverKey = hitAt(e); renderer.domElement.style.cursor = hoverKey ? 'pointer' : 'grab'; };
  const onDown = (e: PointerEvent) => { downAt = [e.clientX, e.clientY]; };
  const onUp = (e: PointerEvent) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6; downAt = null;
    if (moved) return;
    const k = hitAt(e); if (k) o.onSelect(k);
  };
  const onLeave = () => { hoverKey = null; };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointerleave', onLeave);

  let raf = 0;
  function loop() {
    if (destroyed) return;
    if (container.offsetParent !== null) frame(Date.now());
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    setSelected(key: string | null) { selected = key; },
    /** Vuelve a la vista general. */
    resetCamera() {
      camera.position.set(MW / 2 - 3, 19, MH + 12); controls.target.set(MW / 2, 0.4, MH / 2 + 0.5); controls.update();
    },
    destroy() {
      destroyed = true; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp); renderer.domElement.removeEventListener('pointerleave', onLeave);
      const shared = new Set<THREE.Material>(matCache.values());
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.geometry !== geo.box) obj.geometry.dispose();
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) if (!shared.has(m)) { if ((m as THREE.MeshBasicMaterial).map) (m as THREE.MeshBasicMaterial).map!.dispose(); m.dispose(); }
      });
      renderer.dispose(); renderer.domElement.remove(); overlay.innerHTML = '';
    },
  };
}

export type Office3D = ReturnType<typeof createOffice3D>;
