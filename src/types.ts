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
  realStats?: {
    cpu_usage: number;
    ram_usage: number;
    disk_usage: number;
    apps_total: number;
    apps_running: number;
    uptime: string;
    last_update: string;
    container_list?: string[];
  };
}

export interface MetricPoint {
  time: string;
  value: number;
}
