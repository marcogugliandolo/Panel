import React, { useState, useEffect, useRef } from 'react';
import { Activity, Globe, Cloud, Router, Server as ServerIcon, Cpu, ShieldCheck, ZoomIn, ZoomOut, Maximize, Edit2, Save, X, Settings2, GripHorizontal, Lock, User, LogIn, LogOut } from 'lucide-react';
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { cn } from './lib/utils';
import { Server } from './types';
import { INITIAL_SERVERS } from './mockData';

// --- Configuration & Maps ---

const ICON_MAP: Record<string, React.ElementType> = {
  Globe, Cloud, Router, ServerIcon, Cpu
};

const INITIAL_LAYOUT_NODES = [
  { id: 'wan', x: 50, y: 12, title: 'WAN', subtitle: 'INTERNET PÚBLICO', icon: 'Globe', isGateway: true },
  { id: 'vps-contabo', x: 25, y: 45, title: 'CONTABO', subtitle: 'VPS', icon: 'Cloud', serverId: 'vps-contabo' },
  { id: 'vps-oracle', x: 43, y: 45, title: 'ORACLE', subtitle: 'VPS', icon: 'Cloud', serverId: 'vps-oracle' },
  { id: 'router', x: 73, y: 45, title: 'ROUTER', subtitle: '192.168.1.1', icon: 'Router', isGateway: true },
  { id: 'proxmox-node', x: 60, y: 80, title: 'PROXMOX', subtitle: 'NODO', icon: 'ServerIcon', serverId: 'proxmox-node' },
  { id: 'rpi-1', x: 73, y: 80, title: 'RPI-01', subtitle: 'NODO', icon: 'Cpu', serverId: 'rpi-1' },
  { id: 'rpi-2', x: 86, y: 80, title: 'RPI-02', subtitle: 'NODO', icon: 'Cpu', serverId: 'rpi-2' },
];

const INITIAL_LAYOUT_ZONES = [
  { id: 'zone-cloud', x: 10, y: 32, width: 38, height: 28, title: 'Infraestructura Cloud', icon: 'Cloud', color: 'purple' },
  { id: 'zone-home', x: 52, y: 32, width: 42, height: 62, title: 'Red Local (Casa)', icon: 'Router', color: 'blue' }
];

const INITIAL_LAYOUT_WIRES = [
  { id: 'w1', sourceId: 'wan', targetId: 'vps-contabo' },
  { id: 'w2', sourceId: 'wan', targetId: 'vps-oracle' },
  { id: 'w3', sourceId: 'wan', targetId: 'router' },
  { id: 'w4', sourceId: 'router', targetId: 'proxmox-node' },
  { id: 'w5', sourceId: 'router', targetId: 'rpi-1' },
  { id: 'w6', sourceId: 'router', targetId: 'rpi-2' },
];

// --- Components ---

interface SvgWireProps {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  status?: string;
}

const SvgWire: React.FC<SvgWireProps> = ({ startX, startY, endX, endY, status = 'online' }) => {
  const midY = startY + (endY - startY) / 2;
  const color = status === 'online' ? '#00ff9d' : status === 'warning' ? '#ffcc00' : '#ff4444';

  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none z-0" viewBox="0 0 100 100" preserveAspectRatio="none">
      <path
        d={`M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className="opacity-20"
      />
      <path
        d={`M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeDasharray="4 12"
        className="animate-data-flow"
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );
};

interface SchemaNodeProps {
  node: any;
  status: string;
  stats?: { label: string; value: string; percentage?: number; alert: boolean }[];
  isEditMode: boolean;
  onPointerDown: (e: React.PointerEvent, id: string, type: 'node', x: number, y: number) => void;
  onEdit: (item: any, type: 'node') => void;
}

const SchemaNode: React.FC<SchemaNodeProps> = ({ node, status, stats, isEditMode, onPointerDown, onEdit }) => {
  const color = status === 'online' ? '#00ff9d' : status === 'warning' ? '#ffcc00' : '#ff4444';
  const Icon = ICON_MAP[node.icon] || ServerIcon;

  return (
    <div 
      className={cn(
        "absolute z-10 flex flex-col rounded-xl overflow-hidden transition-all duration-300",
        "bg-[#0a0a0c]/80 backdrop-blur-xl border border-white/10",
        !isEditMode && "hover:border-white/30 hover:shadow-[0_0_30px_rgba(0,0,0,0.8)] hover:scale-105 hover:z-20 group",
        isEditMode && "cursor-move ring-2 ring-white/30 shadow-[0_0_20px_rgba(255,255,255,0.1)]",
        node.isGateway ? "w-40" : "w-48"
      )}
      style={{ left: `${node.x}%`, top: `${node.y}%`, transform: 'translate(-50%, -50%)', boxShadow: `0 8px 32px rgba(0,0,0,0.4)` }}
      onPointerDown={(e) => onPointerDown(e, node.id, 'node', node.x, node.y)}
    >
      {isEditMode && (
        <button 
          onClick={(e) => { e.stopPropagation(); onEdit(node, 'node'); }}
          className="absolute top-2 right-2 p-1.5 bg-blue-500/20 hover:bg-blue-500/40 text-blue-400 rounded-md z-50 transition-colors"
        >
          <Edit2 size={12} />
        </button>
      )}

      <div className="h-1 w-full opacity-80 group-hover:opacity-100 transition-opacity" style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)` }} />

      <div className="p-3">
        <div className="flex justify-between items-center mb-1">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-white/5 border border-white/5 group-hover:bg-white/10 transition-colors">
              <Icon size={14} style={{ color }} />
            </div>
            <span className="text-[11px] font-bold text-white uppercase tracking-wider">{node.title}</span>
          </div>
          {!isEditMode && <div className={cn("w-2 h-2 rounded-full", status !== 'online' && "animate-pulse")} style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }} />}
        </div>

        <div className="text-[10px] font-mono text-[#8e9299] mb-3 pl-1 truncate pr-6">{node.subtitle}</div>

        {stats && (
          <div className="flex flex-col gap-2.5 mt-2">
            {stats.map((stat, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="flex justify-between text-[9px] font-mono uppercase px-1">
                  <span className="text-[#8e9299]">{stat.label}</span>
                  <span className={stat.alert ? "text-[#ffcc00] font-bold" : "text-white"}>{stat.value}</span>
                </div>
                {stat.percentage !== undefined && (
                  <div className="w-full bg-black/60 h-1.5 rounded-full overflow-hidden border border-white/5">
                    <div 
                      className="h-full transition-all duration-500 relative" 
                      style={{ width: `${stat.percentage}%`, backgroundColor: stat.alert ? '#ffcc00' : color }}
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/30" />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('server_panel_auth') === 'true';
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);

  const [servers, setServers] = useState<Server[]>(INITIAL_SERVERS);
  
  // Layout State
  const [isEditMode, setIsEditMode] = useState(false);
  const [layoutNodes, setLayoutNodes] = useState(INITIAL_LAYOUT_NODES);
  const [layoutZones, setLayoutZones] = useState(INITIAL_LAYOUT_ZONES);

  // Fetch layout from backend
  useEffect(() => {
    if (!isAuthenticated) return;
    fetch('/api/layout')
      .then(res => res.json())
      .then(data => {
        if (data.nodes && data.zones) {
          setLayoutNodes(data.nodes);
          setLayoutZones(data.zones);
        }
      })
      .catch(console.error);
  }, [isAuthenticated]);
  
  // Drag & Edit State
  const [dragState, setDragState] = useState<{id: string, type: 'node'|'zone', startX: number, startY: number, initialX: number, initialY: number} | null>(null);
  const [editingItem, setEditingItem] = useState<{item: any, type: 'node'|'zone'} | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Simulate live data updates
  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchStats = async () => {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        
        setServers(prevServers => prevServers.map(server => {
          const stat = data.find((s: any) => s.server_id === server.id);
          if (stat) {
            // Si no hay actualización en 3 minutos (180000 ms), marcar como offline
            const isOffline = (Date.now() - stat.last_updated) > 180000;
            return {
              ...server,
              cpuUsage: stat.cpu_usage,
              ramUsage: stat.ram_usage,
              status: isOffline ? 'offline' : 'online',
              realStats: stat // Guardamos los datos reales para usarlos en getStats
            };
          }
          return server;
        }));
      } catch (error) {
        console.error("Error fetching stats:", error);
      }
    };

    fetchStats(); // Primera carga
    const timer = setInterval(fetchStats, 5000); // Actualizar cada 5 segundos
    return () => clearInterval(timer);
  }, [isAuthenticated]);

  // Dragging Logic
  useEffect(() => {
    if (!dragState) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const deltaX = ((e.clientX - dragState.startX) / rect.width) * 100;
      const deltaY = ((e.clientY - dragState.startY) / rect.height) * 100;

      if (dragState.type === 'node') {
        setLayoutNodes(prev => prev.map(n => n.id === dragState.id ? { ...n, x: dragState.initialX + deltaX, y: dragState.initialY + deltaY } : n));
      } else {
        setLayoutZones(prev => prev.map(z => z.id === dragState.id ? { ...z, x: dragState.initialX + deltaX, y: dragState.initialY + deltaY } : z));
      }
    };

    const handlePointerUp = () => setDragState(null);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragState]);

  const handlePointerDown = (e: React.PointerEvent, id: string, type: 'node'|'zone', currentX: number, currentY: number) => {
    if (!isEditMode) return;
    e.stopPropagation();
    setDragState({
      id, type,
      startX: e.clientX,
      startY: e.clientY,
      initialX: currentX,
      initialY: currentY
    });
  };

  const handleSaveEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    if (editingItem?.type === 'node') {
      setLayoutNodes(prev => prev.map(n => n.id === editingItem.item.id ? {
        ...n,
        title: formData.get('title') as string,
        subtitle: formData.get('subtitle') as string,
        icon: formData.get('icon') as string,
      } : n));
    } else if (editingItem?.type === 'zone') {
      setLayoutZones(prev => prev.map(z => z.id === editingItem.item.id ? {
        ...z,
        title: formData.get('title') as string,
        width: Number(formData.get('width')),
        height: Number(formData.get('height')),
      } : z));
    }
    setEditingItem(null);
  };

  const getStats = (s?: any) => {
    if (!s) return [];

    // Si tenemos datos reales de la base de datos
    if (s.realStats) {
      const { cpu_usage, ram_usage, apps_total, apps_running } = s.realStats;
      const appsPercentage = apps_total === 0 ? 0 : (apps_running / apps_total) * 100;
      return [
        { label: 'CPU', value: `${cpu_usage.toFixed(1)}%`, percentage: cpu_usage, alert: cpu_usage > 80 },
        { label: 'RAM', value: `${ram_usage.toFixed(1)}%`, percentage: ram_usage, alert: ram_usage > 85 },
        { label: 'APPS', value: `${apps_running}/${apps_total}`, percentage: appsPercentage, alert: apps_running < apps_total }
      ];
    }

    // Fallback a los datos mockeados si el servidor aún no ha enviado datos
    const appsTotal = s.type === 'Proxmox' ? s.vms : s.containers?.length || 0;
    const appsRunning = s.type === 'Proxmox' ? s.vms : s.containers?.filter((c: any) => c.status === 'running').length || 0;
    const appsPercentage = appsTotal === 0 ? 0 : (appsRunning / appsTotal) * 100;
    
    return [
      { label: 'CPU', value: `${s.cpuUsage.toFixed(1)}%`, percentage: s.cpuUsage, alert: s.cpuUsage > 80 },
      { label: 'RAM', value: `${s.ramUsage.toFixed(1)}%`, percentage: s.ramUsage, alert: s.ramUsage > 85 },
      { label: 'CONTENEDORES', value: `${appsRunning}/${appsTotal}`, percentage: appsPercentage, alert: appsRunning < appsTotal }
    ];
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username === 'gugliama' && password === 'superman94') {
      setIsAuthenticated(true);
      localStorage.setItem('server_panel_auth', 'true');
      setLoginError(false);
    } else {
      setLoginError(true);
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem('server_panel_auth');
  };

  const toggleEditMode = async () => {
    if (isEditMode) {
      // Guardar cambios en el backend al salir del modo edición y ESPERAR a que termine
      try {
        await fetch('/api/layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: layoutNodes, zones: layoutZones })
        });
      } catch (error) {
        console.error('Error al guardar:', error);
      }
    }
    setIsEditMode(!isEditMode);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050505] text-white font-sans relative overflow-hidden">
        <style>{`
          .bg-dot-grid { background-image: radial-gradient(circle at 2px 2px, rgba(255,255,255,0.07) 1px, transparent 0); background-size: 32px 32px; }
        `}</style>
        
        {/* Background effects */}
        <div className="absolute inset-0 bg-dot-grid pointer-events-none" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#00ff9d]/10 blur-[120px] pointer-events-none rounded-full" />
        
        <div className="z-10 w-full max-w-md p-8 bg-[#0a0a0c]/80 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-gradient-to-br from-[#00ff9d] to-[#00cc7d] rounded-2xl flex items-center justify-center text-black shadow-[0_0_30px_rgba(0,255,157,0.4)] mb-4">
              <Activity size={32} strokeWidth={2.5} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Server Panel</h1>
            <p className="text-sm text-[#8e9299] font-mono tracking-wider mt-1">ACCESO RESTRINGIDO</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-2">Usuario</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User size={16} className="text-[#8e9299]" />
                </div>
                <input 
                  type="text" 
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-[#151619] border border-white/10 rounded-xl pl-10 pr-4 py-3 text-white focus:outline-none focus:border-[#00ff9d]/50 focus:ring-1 focus:ring-[#00ff9d]/50 transition-all"
                  placeholder="Introduce tu usuario"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-2">Contraseña</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock size={16} className="text-[#8e9299]" />
                </div>
                <input 
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#151619] border border-white/10 rounded-xl pl-10 pr-4 py-3 text-white focus:outline-none focus:border-[#00ff9d]/50 focus:ring-1 focus:ring-[#00ff9d]/50 transition-all"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>

            {loginError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm text-center font-medium">
                Usuario o contraseña incorrectos
              </div>
            )}

            <button 
              type="submit"
              className="w-full py-3 px-4 bg-[#00ff9d] hover:bg-[#00cc7d] text-black font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(0,255,157,0.2)] hover:shadow-[0_0_30px_rgba(0,255,157,0.4)]"
            >
              <LogIn size={18} />
              Acceder al Panel
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#050505] text-white overflow-hidden relative font-sans">
      <style>{`
        @keyframes data-flow { to { stroke-dashoffset: -16; } }
        .animate-data-flow { animation: data-flow 1s linear infinite; }
        .bg-dot-grid { background-image: radial-gradient(circle at 2px 2px, rgba(255,255,255,0.07) 1px, transparent 0); background-size: 32px 32px; }
      `}</style>

      <div className="absolute inset-0 bg-dot-grid pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-[#00ff9d]/5 blur-[120px] pointer-events-none rounded-full" />
      
      {/* Header */}
      <header className="h-20 border-b border-white/10 bg-[#0a0a0c]/80 backdrop-blur-xl flex items-center justify-between px-8 sticky top-0 z-40">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-gradient-to-br from-[#00ff9d] to-[#00cc7d] rounded-xl flex items-center justify-center text-black shadow-[0_0_20px_rgba(0,255,157,0.4)]">
            <Activity size={24} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-3">
              Server Panel
              {!isEditMode && (
                <span className="px-2 py-0.5 rounded-full bg-[#00ff9d]/10 border border-[#00ff9d]/20 text-[#00ff9d] text-[10px] font-mono tracking-widest flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#00ff9d] animate-pulse" />
                  EN VIVO
                </span>
              )}
              {isEditMode && (
                <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-mono tracking-widest flex items-center gap-1.5">
                  <Settings2 size={10} />
                  MODO EDICIÓN
                </span>
              )}
            </h1>
            <p className="text-xs text-[#8e9299] font-mono tracking-wider mt-0.5">VISTA ESQUEMÁTICA SERVIDORES</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={toggleEditMode}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg border transition-all text-sm font-bold",
              isEditMode 
                ? "bg-blue-500/20 border-blue-500/50 text-blue-400 hover:bg-blue-500/30" 
                : "bg-white/5 border-white/10 text-white hover:bg-white/10"
            )}
          >
            {isEditMode ? <Save size={16} /> : <Edit2 size={16} />}
            {isEditMode ? 'Terminar Edición' : 'Editar Diseño'}
          </button>
          
          {!isEditMode && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10">
              <ShieldCheck size={16} className="text-[#00ff9d]" />
              <span className="text-xs font-mono text-[#8e9299] uppercase tracking-widest">Estado: <span className="text-[#00ff9d] font-bold">CORRECTO</span></span>
            </div>
          )}

          <button 
            onClick={handleLogout}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all text-sm font-bold ml-2"
            title="Cerrar Sesión"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {/* Canvas */}
      <main className={cn("flex-1 relative w-full overflow-hidden", isEditMode ? "cursor-default" : "cursor-grab active:cursor-grabbing")}>
        <TransformWrapper
          initialScale={1}
          minScale={0.4}
          maxScale={4}
          centerOnInit={true}
          wheel={{ step: 0.1 }}
          limitToBounds={false}
          panning={{ disabled: isEditMode || dragState !== null }}
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              {/* Controls Overlay */}
              <div className="absolute bottom-8 right-8 z-50 flex flex-col gap-2">
                <button onClick={() => zoomIn()} className="p-3 bg-[#151619]/80 backdrop-blur border border-white/10 rounded-xl hover:bg-white/10 hover:border-white/30 transition-all shadow-lg group">
                  <ZoomIn size={20} className="text-[#8e9299] group-hover:text-white" />
                </button>
                <button onClick={() => zoomOut()} className="p-3 bg-[#151619]/80 backdrop-blur border border-white/10 rounded-xl hover:bg-white/10 hover:border-white/30 transition-all shadow-lg group">
                  <ZoomOut size={20} className="text-[#8e9299] group-hover:text-white" />
                </button>
                <button onClick={() => resetTransform()} className="p-3 bg-[#151619]/80 backdrop-blur border border-white/10 rounded-xl hover:bg-white/10 hover:border-white/30 transition-all shadow-lg group">
                  <Maximize size={20} className="text-[#8e9299] group-hover:text-white" />
                </button>
              </div>

              <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }} contentStyle={{ width: "100%", height: "100%" }}>
                <div className="relative w-[1400px] h-[800px] mx-auto">
                  
                  {/* Zones */}
                  {layoutZones.map(zone => {
                    const ZoneIcon = ICON_MAP[zone.icon] || Cloud;
                    return (
                      <div 
                        key={zone.id}
                        className={cn(
                          "absolute rounded-2xl border bg-gradient-to-b from-white/5 to-transparent transition-colors",
                          isEditMode ? "border-white/30 cursor-move pointer-events-auto hover:bg-white/10" : "border-white/10 pointer-events-none"
                        )} 
                        style={{ left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.width}%`, height: `${zone.height}%` }}
                        onPointerDown={isEditMode ? (e) => handlePointerDown(e, zone.id, 'zone', zone.x, zone.y) : undefined}
                      >
                        <div className="absolute -top-3 left-6 px-3 py-1 bg-[#0a0a0c] border border-white/10 rounded-full text-[9px] font-bold text-[#8e9299] tracking-widest uppercase shadow-lg flex items-center gap-2">
                          {isEditMode && <GripHorizontal size={10} className="text-white/50" />}
                          <ZoneIcon size={12} className={zone.color === 'purple' ? 'text-purple-400' : 'text-blue-400'} />
                          {zone.title}
                        </div>
                        {isEditMode && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setEditingItem({ item: zone, type: 'zone' }); }}
                            className="absolute -top-3 right-6 p-1 bg-blue-500/20 hover:bg-blue-500/40 text-blue-400 rounded-md z-50 transition-colors"
                          >
                            <Edit2 size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}

                  {/* Wires */}
                  {INITIAL_LAYOUT_WIRES.map(wire => {
                    const source = layoutNodes.find(n => n.id === wire.sourceId);
                    const target = layoutNodes.find(n => n.id === wire.targetId);
                    if (!source || !target) return null;
                    const targetServer = servers.find(s => s.id === target.serverId);
                    return <SvgWire key={wire.id} startX={source.x} startY={source.y} endX={target.x} endY={target.y} status={targetServer?.status || 'online'} />;
                  })}

                  {/* Nodes */}
                  <div ref={containerRef} className="absolute inset-0 pointer-events-none">
                    {layoutNodes.map(node => {
                      const server = servers.find(s => s.id === node.serverId);
                      return (
                        <div key={node.id} className="pointer-events-auto">
                          <SchemaNode 
                            node={node} 
                            status={server?.status || 'online'} 
                            stats={getStats(server)} 
                            isEditMode={isEditMode}
                            onPointerDown={handlePointerDown}
                            onEdit={(item) => setEditingItem({ item, type: 'node' })}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </TransformComponent>
            </>
          )}
        </TransformWrapper>
      </main>

      {/* Edit Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleSaveEdit} className="bg-[#151619] border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Settings2 size={20} className="text-blue-400" />
                Editar {editingItem.type === 'node' ? 'Nodo' : 'Zona'}
              </h3>
              <button type="button" onClick={() => setEditingItem(null)} className="text-[#8e9299] hover:text-white">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-1">Título</label>
                <input name="title" defaultValue={editingItem.item.title} className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500" required />
              </div>
              
              {editingItem.type === 'node' && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-1">Subtítulo / IP</label>
                    <input name="subtitle" defaultValue={editingItem.item.subtitle} className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500" required />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-1">Icono</label>
                    <select name="icon" defaultValue={editingItem.item.icon} className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500">
                      {Object.keys(ICON_MAP).map(icon => <option key={icon} value={icon}>{icon}</option>)}
                    </select>
                  </div>
                </>
              )}

              {editingItem.type === 'zone' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-1">Ancho (%)</label>
                    <input name="width" type="number" defaultValue={editingItem.item.width} className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500" required />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[#8e9299] uppercase tracking-wider mb-1">Alto (%)</label>
                    <input name="height" type="number" defaultValue={editingItem.item.height} className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500" required />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-8">
              <button type="button" onClick={() => setEditingItem(null)} className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white text-sm font-bold transition-colors">
                Cancelar
              </button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-bold transition-colors flex items-center gap-2">
                <Save size={16} /> Guardar Cambios
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
