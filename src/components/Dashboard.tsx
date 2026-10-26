import { WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Layout } from '../../shared/types';
import { api, type Session } from '../api';
import { useNow, usePolling, useStoredState } from '../lib/hooks';
import { buildAlerts, buildServerViews, type PanelAlert } from '../lib/status';
import { Header, type View } from './Header';
import { OfficeView } from './office/OfficeView';
import { RECEPTION_KEY, type SceneNetDevice } from './office/scene';
import { ServerDrawer } from './server/ServerDrawer';
import { TopologyCanvas } from './topology/TopologyCanvas';
import { Spinner, useToast } from './ui';

/** Fecha local AAAA-MM-DD: los avisos ocultos vuelven al día siguiente. */
const localDay = () => new Date().toLocaleDateString('sv-SE');
const VIEWS: View[] = ['clasica', 'oficina', 'edificio'];

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [storedView, setView] = useStoredState<View>('panel:vista', 'clasica');
  const view: View = VIEWS.includes(storedView) ? storedView : 'clasica';
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dismissed, setDismissed] = useStoredState<Record<string, string>>('dismissed_alerts', {});
  const [editing, setEditing] = useState(false);
  const [saveSignal, setSaveSignal] = useState(0);
  const toast = useToast();
  const now = useNow(15_000);

  const layoutQuery = usePolling(api.layout, 0);
  const statsQuery = usePolling(api.stats, 5_000);
  const monitorsQuery = usePolling(api.monitors, 15_000);
  const portainerQuery = usePolling(api.portainerStatus, 60_000);
  const portainerOk = portainerQuery.data?.ok ?? false;
  const endpointsQuery = usePolling(() => (portainerOk ? api.endpoints() : Promise.resolve(null)), 5 * 60_000, [portainerOk]);

  const layout = layoutQuery.data?.layout ?? null;
  const servers = useMemo(() => buildServerViews(layout?.nodes ?? [], statsQuery.data ?? []), [layout, statsQuery.data]);
  const serversByKey = useMemo(() => new Map(servers.map((s) => [s.key, s])), [servers]);
  const knownServerIds = useMemo(() => (statsQuery.data ?? []).map((s) => s.serverId), [statsQuery.data]);
  // Lo que va al CPD de la oficina: nodos del esquema que no son servidores ni Internet (router, firewall…). Routers primero.
  const network = useMemo<SceneNetDevice[]>(
    () =>
      (layout?.nodes ?? [])
        .filter((n) => !n.serverId && n.icon !== 'Globe' && n.icon !== 'Cloud')
        .map((n) => ({
          key: n.id,
          title: n.title,
          detail: n.ip || n.subtitle || null,
          kind: n.icon === 'Router' ? ('router' as const) : n.icon === 'Shield' ? ('firewall' as const) : ('box' as const),
        }))
        .sort((a, b) => Number(b.kind === 'router') - Number(a.kind === 'router')),
    [layout],
  );

  const today = localDay();
  const allAlerts = useMemo(() => buildAlerts(servers, monitorsQuery.data ?? []), [servers, monitorsQuery.data]);
  const alerts = allAlerts.filter((a) => dismissed[a.id] !== today);

  // Limpia avisos ocultos de días anteriores.
  useEffect(() => {
    const stale = Object.entries(dismissed).filter(([, day]) => day !== today);
    if (stale.length) setDismissed(Object.fromEntries(Object.entries(dismissed).filter(([, day]) => day === today)));
  }, [dismissed, today, setDismissed]);

  const saveLayout = useCallback(
    async (next: Layout) => {
      const result = await api.saveLayout(next);
      layoutQuery.setData(result);
    },
    [layoutQuery],
  );

  async function linkEndpoint(nodeId: string, endpointId: number) {
    if (!layout) return;
    try {
      await saveLayout({ ...layout, nodes: layout.nodes.map((n) => (n.id === nodeId ? { ...n, portainerEndpointId: endpointId } : n)) });
      toast('Servidor vinculado con Portainer');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo vincular', 'bad');
    }
  }

  function changeView(next: View) {
    setView(next);
    if (next === 'clasica' && selectedKey === RECEPTION_KEY) setSelectedKey(null);
  }

  function openAlert(alert: PanelAlert) {
    if (alert.target.kind === 'server') {
      setSelectedKey(alert.target.key);
    } else {
      // Las webs las atiende la recepción de la oficina.
      if (view === 'clasica') setView('oficina');
      setSelectedKey(RECEPTION_KEY);
    }
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      onLogout();
    }
  }

  const selected = selectedKey ? serversByKey.get(selectedKey) ?? null : null;
  const connectionError = statsQuery.error && statsQuery.data !== null ? statsQuery.error : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#050505]">
      <Header
        view={view}
        onViewChange={changeView}
        alerts={alerts}
        dismissedCount={allAlerts.length - alerts.length}
        onDismiss={(alert) => setDismissed((d) => ({ ...d, [alert.id]: today }))}
        onRestoreDismissed={() => setDismissed({})}
        onOpenAlert={openAlert}
        onLogout={logout}
        username={session.username}
        connectionError={connectionError}
        isEditing={editing}
        onToggleEdit={() => (editing ? setSaveSignal((n) => n + 1) : setEditing(true))}
      />

      {connectionError && (
        <div role="alert" className="flex items-center justify-center gap-2 border-b border-bad/25 bg-bad/10 px-4 py-2 text-[13px] text-bad">
          <WifiOff size={14} aria-hidden />
          Se ha perdido la conexión con el panel. Los datos mostrados pueden no estar al día.
        </div>
      )}

      <main className="relative min-h-0 flex-1">
        {view === 'clasica' && (
          <>
            <div className="bg-dot-grid pointer-events-none absolute inset-0" />
            <div className="pointer-events-none absolute top-0 left-1/2 h-[400px] w-[800px] max-w-full -translate-x-1/2 rounded-full bg-[#00ff9d]/5 blur-[120px]" />
            {layout ? (
              <TopologyCanvas
                layout={layout}
                servers={serversByKey}
                endpoints={endpointsQuery.data}
                knownServerIds={knownServerIds}
                onSave={saveLayout}
                onSelect={setSelectedKey}
                now={now}
                isEditing={editing}
                onEditingChange={setEditing}
                saveSignal={saveSignal}
              />
            ) : (
              <Spinner label="Cargando esquema" />
            )}
          </>
        )}
        {/* La oficina sigue viva en segundo plano para no perder el registro ni las animaciones. */}
        <div className="h-full" hidden={view === 'clasica'}>
          <OfficeView
            mode={view === 'edificio' ? 'edificio' : 'oficina'}
            servers={servers}
            network={network}
            monitors={monitorsQuery.data}
            selectedKey={view === 'clasica' ? null : selectedKey}
            onSelect={setSelectedKey}
            onFloor={() => setView('oficina')}
            onMonitorsChange={monitorsQuery.refresh}
            portainer={portainerQuery.data}
            endpoints={endpointsQuery.data}
            onLinkEndpoint={linkEndpoint}
            onForgotten={() => void statsQuery.refresh()}
            now={now}
          />
        </div>
      </main>

      {view === 'clasica' && selected && (
        <ServerDrawer
          key={selected.key}
          server={selected}
          portainer={portainerQuery.data}
          endpoints={endpointsQuery.data}
          now={now}
          onClose={() => setSelectedKey(null)}
          onLinkEndpoint={linkEndpoint}
          onForgotten={() => {
            setSelectedKey(null);
            void statsQuery.refresh();
          }}
        />
      )}
    </div>
  );
}
