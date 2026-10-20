import { Cloud, Cpu, Database, Globe, HardDrive, Router, Server, Shield, type LucideIcon } from 'lucide-react';
import type { NodeIcon } from '../../shared/types';

export const NODE_ICONS: Record<NodeIcon, { icon: LucideIcon; label: string }> = {
  Globe: { icon: Globe, label: 'Internet' },
  Cloud: { icon: Cloud, label: 'Nube / VPS' },
  Router: { icon: Router, label: 'Router' },
  ServerIcon: { icon: Server, label: 'Servidor' },
  Cpu: { icon: Cpu, label: 'Placa (Raspberry Pi)' },
  Database: { icon: Database, label: 'Base de datos' },
  HardDrive: { icon: HardDrive, label: 'Almacenamiento / NAS' },
  Shield: { icon: Shield, label: 'Firewall / VPN' },
};

export const nodeIcon = (name: NodeIcon | undefined): LucideIcon => NODE_ICONS[name ?? 'ServerIcon']?.icon ?? Server;
