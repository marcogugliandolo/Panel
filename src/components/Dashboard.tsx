import { WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Layout } from '../../shared/types';
import { api, type Session } from '../api';
import { useMediaQuery, useNow, usePolling, useStoredState } from '../lib/hooks';
import { buildAlerts, buildServerViews, type PanelAlert } from '../lib/status';
import { Header, type View } from './Header';
import { MonitorsView } from './monitors/MonitorsView';
import { ServerDrawer } from './server/ServerDrawer';
import { ServerGrid } from './ServerGrid';
import { TopologyCanvas } from './topology/TopologyCanvas';
import { Spinner, useToast } from './ui';

/** Fecha local AAAA-MM-DD: los avisos ocultos vuelven al día siguiente. */
const localDay = () => new Date().toLocaleDateString('sv-SE');

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const isSmallScreen = useMediaQuery('(max-width: 767px)');
  const [view, setView] = useStoredState<View>('panel:view', isSmallScreen ? 'servers' : 'map');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusMonitor, setFocusMonitor] = useState<number | null>(null);
  const [dismissed, setDismissed] = useStoredState<Record<string, string>>('dismissed_alerts', {});
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

  function openAlert(alert: PanelAlert) {
    if (alert.target.kind === 'server') {
      setSelectedKey(alert.target.key);
    } else {
      setView('webs');
      setFocusMonitor(alert.target.id);
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
    <div className="flex h-dvh flex-col overflow-hidden">
      <Header
        view={view}
        onViewChange={(next) => {
          setView(next);
          if (next !== 'webs') setFocusMonitor(null);
        }}
        alerts={alerts}
        dismissedCount={allAlerts.length - alerts.length}
        onDismiss={(alert) => setDismissed((d) => ({ ...d, [alert.id]: today }))}
        onRestoreDismissed={() => setDismissed({})}
        onOpenAlert={openAlert}
        onLogout={logout}
        username={session.username}
        connectionError={connectionError}
      />

      {connectionError && (
        <div role="alert" className="flex items-center justify-center gap-2 border-b border-bad/25 bg-bad/10 px-4 py-2 text-[13px] text-bad">
          <WifiOff size={14} aria-hidden />
          Se ha perdido la conexión con el panel. Los datos mostrados pueden no estar al día.
        </div>
      )}

      <main className="relative min-h-0 flex-1">
        <div className="bg-dot-grid pointer-events-none absolute inset-0" />
        {view === 'map' ? (
          layout ? (
            <TopologyCanvas
              layout={layout}
              servers={serversByKey}
              endpoints={endpointsQuery.data}
              knownServerIds={knownServerIds}
              onSave={saveLayout}
              onSelect={setSelectedKey}
              now={now}
            />
          ) : (
            <Spinner label="Cargando esquema" />
          )
        ) : (
          <div className="scrollbar-thin relative h-full overflow-y-auto">
            {view === 'servers' ? (
              statsQuery.data === null && statsQuery.loading ? (
                <Spinner label="Cargando servidores" />
              ) : (
                <ServerGrid servers={servers} onSelect={setSelectedKey} now={now} />
              )
            ) : (
              <MonitorsView
                monitors={monitorsQuery.data}
                error={monitorsQuery.error}
                onChange={monitorsQuery.refresh}
                focusId={focusMonitor}
                now={now}
              />
            )}
          </div>
        )}
      </main>

      {selected && (
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
