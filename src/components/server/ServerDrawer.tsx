import { Activity, Boxes, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { PortainerEndpoint, PortainerStatus } from '../../../shared/types';
import { api } from '../../api';
import { HEALTH_META, type ServerView } from '../../lib/status';
import { Button, Dialog, EmptyState, Segmented, StatusBadge, useConfirm, useToast } from '../ui';
import { ContainersPanel } from './ContainersPanel';
import { MetricsPanel } from './MetricsPanel';

type Tab = 'metrics' | 'containers';

export function ServerDrawer({
  server,
  portainer,
  endpoints,
  now,
  onClose,
  onLinkEndpoint,
  onForgotten,
}: {
  server: ServerView;
  portainer: PortainerStatus | null;
  endpoints: PortainerEndpoint[] | null;
  now: number;
  onClose: () => void;
  onLinkEndpoint: (nodeId: string, endpointId: number) => Promise<void>;
  onForgotten: () => void;
}) {
  const [tab, setTab] = useState<Tab>('metrics');
  const confirm = useConfirm();
  const toast = useToast();
  const meta = HEALTH_META[server.health];
  const stats = server.stats;
  const containerCount = stats?.appsTotal ?? stats?.containers.length ?? 0;

  async function forget() {
    if (!server.serverId) return;
    const ok = await confirm({
      title: `Olvidar ${server.title}`,
      message: (
        <p>
          Se borrarán las métricas y el historial de <span className="font-mono text-ink">{server.serverId}</span>. Si el script sigue
          enviando datos, volverá a aparecer.
        </p>
      ),
      confirmLabel: 'Olvidar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.forgetServer(server.serverId);
      toast(`${server.title} olvidado`);
      onForgotten();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'No se pudo borrar', 'bad');
    }
  }

  return (
    <Dialog
      open
      variant="sheet"
      onClose={onClose}
      title={
        <span className="flex flex-wrap items-center gap-2.5">
          {server.title}
          <StatusBadge tone={meta.tone} label={meta.label} />
        </span>
      }
      description={
        <span className="font-mono text-xs">
          {server.serverId}
          {stats?.hostname && stats.hostname !== server.serverId ? ` · ${stats.hostname}` : ''}
          {server.node?.ip ? ` · ${server.node.ip}` : ''}
        </span>
      }
      footer={
        !server.node && stats ? (
          <Button variant="danger" size="sm" icon={<Trash2 size={14} aria-hidden />} onClick={forget} className="mr-auto">
            Olvidar este servidor
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {server.problems.length > 0 && (
          <ul
            className={`space-y-1 rounded-xl border p-3 text-[13px] ${server.health === 'offline' ? 'border-bad/25 bg-bad/[0.07] text-bad' : 'border-warn/25 bg-warn/[0.06] text-warn'}`}
          >
            {server.problems.map((problem) => (
              <li key={problem.id}>
                <span className="font-medium">{problem.title}.</span> <span className="opacity-85">{problem.detail}</span>
              </li>
            ))}
          </ul>
        )}

        <Segmented<Tab>
          label="Sección"
          value={tab}
          onChange={setTab}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          options={[
            { value: 'metrics', label: <><Activity size={14} aria-hidden /> Métricas</> },
            { value: 'containers', label: <><Boxes size={14} aria-hidden /> Contenedores{containerCount ? ` (${containerCount})` : ''}</> },
          ]}
        />

        {!server.serverId ? null : !stats && tab === 'metrics' ? (
          <EmptyState icon={<Activity size={24} aria-hidden />} title="Este servidor no ha enviado datos">
            Comprueba que el script de métricas está instalado y usa <code className="font-mono text-ink-2">SERVER_ID={server.serverId}</code>.
          </EmptyState>
        ) : tab === 'metrics' ? (
          <MetricsPanel serverId={server.serverId} stats={stats} now={now} />
        ) : (
          <ContainersPanel
            serverTitle={server.title}
            reported={stats?.containers ?? []}
            endpointId={server.node?.portainerEndpointId}
            portainer={portainer}
            endpoints={endpoints}
            onLinkEndpoint={server.node ? (endpointId) => onLinkEndpoint(server.node!.id, endpointId) : undefined}
          />
        )}
      </div>
    </Dialog>
  );
}
