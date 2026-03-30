export type ServerStatus = 'online' | 'offline' | 'warning';

export interface Container {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'restarting';
  image: string;
  cpu: number;
  memory: number;
}

export interface Server {
  id: string;
  name: string;
  type: 'Raspberry Pi' | 'VPS Contabo' | 'VPS Oracle' | 'Proxmox';
  location: 'Home' | 'Cloud';
  ip: string;
  status: ServerStatus;
  cpuUsage: number;
  ramUsage: number;
  diskUsage: number;
  uptime: string;
  containers?: Container[];
  vms?: number; // For Proxmox
}

export interface MetricPoint {
  time: string;
  value: number;
}
