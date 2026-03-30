import { Server } from './types';

export const INITIAL_SERVERS: Server[] = [
  {
    id: 'rpi-1',
    name: 'Raspberry Pi 01',
    type: 'Raspberry Pi',
    location: 'Home',
    ip: '192.168.1.10',
    status: 'online',
    cpuUsage: 12,
    ramUsage: 45,
    diskUsage: 30,
    uptime: '12d 4h 22m',
    containers: [
      { id: 'c1', name: 'Home Assistant', status: 'running', image: 'homeassistant/home-assistant', cpu: 2.5, memory: 256 },
      { id: 'c2', name: 'Pi-hole', status: 'running', image: 'pihole/pihole', cpu: 0.8, memory: 128 },
      { id: 'c3', name: 'Zigbee2MQTT', status: 'running', image: 'koenkk/zigbee2mqtt', cpu: 1.2, memory: 64 },
    ]
  },
  {
    id: 'rpi-2',
    name: 'Raspberry Pi 02',
    type: 'Raspberry Pi',
    location: 'Home',
    ip: '192.168.1.11',
    status: 'online',
    cpuUsage: 8,
    ramUsage: 32,
    diskUsage: 15,
    uptime: '45d 1h 05m',
    containers: [
      { id: 'c4', name: 'Nginx Proxy Manager', status: 'running', image: 'jc21/nginx-proxy-manager', cpu: 0.5, memory: 180 },
      { id: 'c5', name: 'Wireguard', status: 'running', image: 'linuxserver/wireguard', cpu: 0.2, memory: 45 },
    ]
  },
  {
    id: 'vps-contabo',
    name: 'Contabo VPS Main',
    type: 'VPS Contabo',
    location: 'Cloud',
    ip: '161.97.x.x',
    status: 'online',
    cpuUsage: 25,
    ramUsage: 60,
    diskUsage: 45,
    uptime: '128d 14h',
    containers: [
      { id: 'c6', name: 'Web Server', status: 'running', image: 'nginx:latest', cpu: 5.2, memory: 512 },
      { id: 'c7', name: 'Database', status: 'running', image: 'postgres:15', cpu: 8.4, memory: 1024 },
      { id: 'c8', name: 'Redis', status: 'running', image: 'redis:alpine', cpu: 1.1, memory: 256 },
    ]
  },
  {
    id: 'vps-oracle',
    name: 'Oracle Cloud Free',
    type: 'VPS Oracle',
    location: 'Cloud',
    ip: '152.67.x.x',
    status: 'warning',
    cpuUsage: 85,
    ramUsage: 92,
    diskUsage: 88,
    uptime: '5d 2h',
    containers: [
      { id: 'c9', name: 'Dev App', status: 'running', image: 'node:20', cpu: 45.0, memory: 2048 },
      { id: 'c10', name: 'Backup Job', status: 'restarting', image: 'restic/restic', cpu: 15.0, memory: 512 },
    ]
  },
  {
    id: 'proxmox-node',
    name: 'Proxmox Home',
    type: 'Proxmox',
    location: 'Home',
    ip: '192.168.1.50',
    status: 'online',
    cpuUsage: 18,
    ramUsage: 55,
    diskUsage: 22,
    uptime: '302d 8h',
    vms: 8
  }
];
