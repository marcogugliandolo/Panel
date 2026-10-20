import type { Layout, LayoutWire } from './types';

// Esquema inicial: el mismo que tenía el panel antes de poder editar conexiones.

export const DEFAULT_WIRES: LayoutWire[] = [
  { id: 'w1', sourceId: 'wan', targetId: 'vps-contabo' },
  { id: 'w2', sourceId: 'wan', targetId: 'vps-oracle' },
  { id: 'w3', sourceId: 'wan', targetId: 'router' },
  { id: 'w4', sourceId: 'router', targetId: 'proxmox-node' },
  { id: 'w5', sourceId: 'router', targetId: 'rpi-1' },
  { id: 'w6', sourceId: 'router', targetId: 'rpi-2' },
];

export const DEFAULT_LAYOUT: Layout = {
  nodes: [
    { id: 'wan', x: 50, y: 12, title: 'WAN', subtitle: 'Internet público', icon: 'Globe', isGateway: true },
    { id: 'vps-contabo', x: 25, y: 45, title: 'Contabo', subtitle: 'VPS', icon: 'Cloud', serverId: 'vps-contabo' },
    { id: 'vps-oracle', x: 43, y: 45, title: 'Oracle', subtitle: 'VPS', icon: 'Cloud', serverId: 'vps-oracle' },
    { id: 'router', x: 73, y: 45, title: 'Router', subtitle: '192.168.1.1', icon: 'Router', isGateway: true },
    { id: 'proxmox-node', x: 60, y: 80, title: 'Proxmox', subtitle: 'Nodo', icon: 'ServerIcon', serverId: 'proxmox-node' },
    { id: 'rpi-1', x: 73, y: 80, title: 'RPi-01', subtitle: 'Nodo', icon: 'Cpu', serverId: 'rpi-1' },
    { id: 'rpi-2', x: 86, y: 80, title: 'RPi-02', subtitle: 'Nodo', icon: 'Cpu', serverId: 'rpi-2' },
  ],
  zones: [
    { id: 'zone-cloud', x: 10, y: 32, width: 38, height: 28, title: 'Infraestructura cloud', icon: 'Cloud', color: 'purple' },
    { id: 'zone-home', x: 52, y: 32, width: 42, height: 62, title: 'Red local (casa)', icon: 'Router', color: 'blue' },
  ],
  wires: DEFAULT_WIRES,
};
