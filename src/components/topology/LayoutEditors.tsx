import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { LayoutNode, LayoutZone, NodeIcon, PortainerEndpoint, ZoneColor } from '../../../shared/types';
import { NODE_ICONS } from '../../lib/icons';
import { isProxmoxHost } from '../../lib/status';
import { Button, Dialog, Field, inputClass, Segmented } from '../ui';

const ZONE_COLORS: { value: ZoneColor; label: string }[] = [
  { value: 'blue', label: 'Azul' },
  { value: 'purple', label: 'Violeta' },
  { value: 'green', label: 'Verde' },
  { value: 'amber', label: 'Ámbar' },
];

export function NodeEditor({
  node,
  isNew,
  knownServerIds,
  endpoints,
  onSave,
  onDelete,
  onClose,
}: {
  node: LayoutNode;
  isNew: boolean;
  knownServerIds: string[];
  endpoints: PortainerEndpoint[] | null;
  onSave: (node: LayoutNode) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<LayoutNode>(node);
  const [kind, setKind] = useState<'server' | 'gateway'>(node.isGateway || (!node.serverId && !isNew) ? 'gateway' : 'server');
  const set = <K extends keyof LayoutNode>(key: K, value: LayoutNode[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const serverIdValid = kind === 'gateway' || /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(draft.serverId ?? '');
  const proxmox = isProxmoxHost({ serverId: draft.serverId, title: draft.title });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.title.trim() || !serverIdValid) return;
    const result: LayoutNode = { ...draft, title: draft.title.trim() };
    if (kind === 'gateway') {
      result.isGateway = true;
      delete result.serverId;
      delete result.portainerEndpointId;
    } else {
      delete result.isGateway;
      if (proxmox) delete result.portainerEndpointId;
    }
    onSave(result);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'Nuevo nodo' : 'Editar nodo'}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} onClick={onDelete} className="mr-auto">
              Eliminar
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="node-editor" disabled={!serverIdValid || !draft.title.trim()}>
            {isNew ? 'Añadir' : 'Guardar'}
          </Button>
        </>
      }
    >
      <form id="node-editor" onSubmit={handleSubmit} className="space-y-4">
        <Segmented
          label="Tipo de nodo"
          value={kind}
          onChange={setKind}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          options={[
            { value: 'server', label: 'Servidor con métricas' },
            { value: 'gateway', label: 'Elemento de red' },
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre">
            {(id) => (
              <input id={id} className={inputClass} value={draft.title} maxLength={40} required onChange={(e) => set('title', e.target.value)} />
            )}
          </Field>
          <Field label="Subtítulo">
            {(id) => (
              <input id={id} className={inputClass} value={draft.subtitle ?? ''} maxLength={60} onChange={(e) => set('subtitle', e.target.value)} />
            )}
          </Field>
          <Field label="IP o dirección">
            {(id) => (
              <input
                id={id}
                className={`${inputClass} font-mono`}
                value={draft.ip ?? ''}
                maxLength={60}
                placeholder="192.168.1.10"
                onChange={(e) => set('ip', e.target.value)}
              />
            )}
          </Field>
          <Field label="Icono">
            {(id) => (
              <select id={id} className={inputClass} value={draft.icon} onChange={(e) => set('icon', e.target.value as NodeIcon)}>
                {(Object.keys(NODE_ICONS) as NodeIcon[]).map((key) => (
                  <option key={key} value={key}>
                    {NODE_ICONS[key].label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        {kind === 'server' && (
          <div className="space-y-4 rounded-xl border border-line bg-bg/60 p-4">
            <Field
              label="Id del servidor"
              error={draft.serverId && !serverIdValid ? 'Solo letras, números, puntos, guiones y guiones bajos' : null}
              hint={<>El mismo valor que <code className="font-mono text-ink-2">SERVER_ID</code> en el script de métricas.</>}
            >
              {(id) => (
                <>
                  <input
                    id={id}
                    list="known-server-ids"
                    className={`${inputClass} font-mono`}
                    value={draft.serverId ?? ''}
                    maxLength={64}
                    required
                    placeholder="rpi-1"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(e) => set('serverId', e.target.value.trim())}
                  />
                  <datalist id="known-server-ids">
                    {knownServerIds.map((serverId) => (
                      <option key={serverId} value={serverId} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field
              label="Entorno de Portainer"
              hint={
                proxmox
                  ? 'Proxmox no tiene el agente de Portainer: no se vincula.'
                  : endpoints === null
                    ? 'Portainer no está disponible: configura PORTAINER_URL y PORTAINER_TOKEN.'
                    : 'Para ver y controlar sus contenedores desde el panel.'
              }
            >
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  disabled={endpoints === null || proxmox}
                  value={proxmox ? '' : draft.portainerEndpointId ?? ''}
                  onChange={(e) => set('portainerEndpointId', e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">Sin vincular</option>
                  {endpoints?.map((endpoint) => (
                    <option key={endpoint.id} value={endpoint.id}>
                      {endpoint.name}
                      {endpoint.online ? '' : ' (desconectado)'}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        )}
      </form>
    </Dialog>
  );
}

export function ZoneEditor({
  zone,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  zone: LayoutZone;
  isNew: boolean;
  onSave: (zone: LayoutZone) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<LayoutZone>(zone);
  const set = <K extends keyof LayoutZone>(key: K, value: LayoutZone[K]) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'Nueva zona' : 'Editar zona'}
      description="Arrastra la esquina inferior derecha de la zona para cambiar su tamaño."
      footer={
        <>
          {!isNew && (
            <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} onClick={onDelete} className="mr-auto">
              Eliminar
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="zone-editor" disabled={!draft.title.trim()}>
            {isNew ? 'Añadir' : 'Guardar'}
          </Button>
        </>
      }
    >
      <form
        id="zone-editor"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ ...draft, title: draft.title.trim() });
        }}
      >
        <Field label="Nombre">
          {(id) => (
            <input id={id} className={inputClass} value={draft.title} maxLength={60} required onChange={(e) => set('title', e.target.value)} />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Color">
            {(id) => (
              <select id={id} className={inputClass} value={draft.color} onChange={(e) => set('color', e.target.value as ZoneColor)}>
                {ZONE_COLORS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Icono">
            {(id) => (
              <select id={id} className={inputClass} value={draft.icon} onChange={(e) => set('icon', e.target.value as NodeIcon)}>
                {(Object.keys(NODE_ICONS) as NodeIcon[]).map((key) => (
                  <option key={key} value={key}>
                    {NODE_ICONS[key].label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
