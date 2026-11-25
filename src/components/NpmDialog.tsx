import { ArrowLeft, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type NpmHost, type NpmInstance, type NpmInstanceInput } from '../api';
import { timeAgo } from '../lib/format';
import { cn } from '../lib/utils';
import { Button, Dialog, Field, Spinner, StatusBadge, inputClass, useConfirm, useToast } from './ui';

type Step = { kind: 'list' } | { kind: 'form'; editing: NpmInstance | null } | { kind: 'hosts'; instance: NpmInstance };

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);
const emptyForm = (serverId: string | null): NpmInstanceInput => ({ name: '', url: '', email: '', password: '', serverId, autoImport: true });

/** Conexión con Nginx Proxy Manager: de ahí salen todas las webs y a qué contenedor manda cada una. */
export function NpmDialog({
  open,
  onClose,
  servers,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  servers: { serverId: string; title: string }[];
  onImported: () => void;
}) {
  const [instances, setInstances] = useState<NpmInstance[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [form, setForm] = useState<NpmInstanceInput>(emptyForm(null));
  const [hosts, setHosts] = useState<NpmHost[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const titleOf = (id: string | null) => servers.find((s) => s.serverId === id)?.title ?? id ?? 'sin indicar';

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInstances(null);
    api
      .npmInstances()
      .then((list) => {
        setInstances(list);
        if (list.length === 0) openForm(null);
        else setStep({ kind: 'list' });
      })
      .catch((caught) => setError(errorText(caught, 'No se pudo leer la configuración')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, 'Algo ha fallado'));
    } finally {
      setBusy(null);
    }
  }

  function openForm(editing: NpmInstance | null) {
    setError(null);
    setForm(
      editing
        ? { name: editing.name, url: editing.url, email: editing.email, password: '', serverId: editing.serverId, autoImport: editing.autoImport }
        : emptyForm(servers.find((s) => /oracle/i.test(s.title))?.serverId ?? servers[0]?.serverId ?? null),
    );
    setStep({ kind: 'form', editing });
  }

  const showHosts = (instance: NpmInstance, refresh = false) =>
    run('hosts', async () => {
      const list = await api.npmHosts(instance.id, refresh);
      setHosts(list);
      // Por defecto, todas las activas que aún no se vigilan.
      setPicked(new Set(list.filter((h) => h.enabled).flatMap((h) => h.importable.filter((d) => !h.watched.includes(d)))));
      setStep({ kind: 'hosts', instance });
    });

  const save = (editing: NpmInstance | null) =>
    run('save', async () => {
      const input = { ...form, name: form.name.trim() || `NPM ${titleOf(form.serverId)}` };
      const saved = editing ? await api.npmUpdate(editing.id, input) : await api.npmAdd(input);
      const list = await api.npmInstances();
      setInstances(list);
      toast(editing ? 'Cambios guardados' : `${saved.name} conectado: ${saved.hostsCount ?? 0} webs encontradas`);
      if (editing) setStep({ kind: 'list' });
      else await showHosts(saved);
    });

  const remove = async (instance: NpmInstance) => {
    const ok = await confirm({
      title: `Quitar ${instance.name}`,
      message: <p>El panel dejará de leer este Nginx Proxy Manager. Las webs que ya se vigilan siguen vigilándose.</p>,
      confirmLabel: 'Quitar',
      danger: true,
    });
    if (!ok) return;
    await run('remove', async () => {
      await api.npmRemove(instance.id);
      const list = await api.npmInstances();
      setInstances(list);
      if (!list.length) openForm(null);
    });
  };

  const importPicked = (instance: NpmInstance) =>
    run('import', async () => {
      const { added } = await api.npmImport(instance.id, [...picked]);
      toast(added.length ? `Se vigilan ${added.length} webs nuevas` : 'No había webs nuevas que añadir');
      onImported();
      setHosts(await api.npmHosts(instance.id));
      setPicked(new Set());
    });

  const pendingCount = useMemo(() => picked.size, [picked]);

  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (!instances && !error) {
    body = (
      <div className="flex justify-center py-8">
        <Spinner label="Cargando" />
      </div>
    );
  } else if (step.kind === 'form') {
    const editing = step.editing;
    body = (
      <div className="space-y-4 text-sm text-ink-2">
        {!editing && (
          <p>
            Con tu Nginx Proxy Manager conectado, el panel sabe todas tus webs y a qué contenedor manda cada una. Así, cuando una se cae, puede
            decirte en qué punto de la ruta está el problema.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Servidor donde está" hint="Para saber qué contenedores tiene detrás.">
            {(id) => (
              <select id={id} value={form.serverId ?? ''} onChange={(e) => setForm({ ...form, serverId: e.target.value || null })} className={inputClass}>
                <option value="">Sin indicar</option>
                {servers.map((s) => (
                  <option key={s.serverId} value={s.serverId}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Nombre">
            {(id) => (
              <input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={`NPM ${titleOf(form.serverId)}`} className={inputClass} />
            )}
          </Field>
        </div>
        <Field label="Dirección del panel de NPM" hint="La de administración (puerto 81). Si NPM está en el mismo servidor que este panel, suele funcionar http://172.17.0.1:81.">
          {(id) => (
            <input
              id={id}
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value.trim() })}
              placeholder="http://172.17.0.1:81"
              spellCheck={false}
              autoCapitalize="none"
              className={`${inputClass} font-mono text-[13px]`}
              autoFocus={!editing}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Usuario (email)">
            {(id) => (
              <input id={id} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim() })} autoComplete="off" className={inputClass} />
            )}
          </Field>
          <Field label="Contraseña" hint={editing ? 'Déjala vacía para mantener la actual.' : undefined}>
            {(id) => (
              <input id={id} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" className={inputClass} />
            )}
          </Field>
        </div>
        <p className="rounded-lg border border-line bg-bg px-3 py-2 text-xs text-ink-3">
          Mejor con un usuario solo para el panel: en NPM, <b className="text-ink-2">Users → Add User</b> y en sus permisos deja <b className="text-ink-2">Proxy Hosts</b> en «View Only».
        </p>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={form.autoImport} onChange={(e) => setForm({ ...form, autoImport: e.target.checked })} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
          <span>
            <span className="block text-ink">Vigilar solas las webs nuevas</span>
            <span className="block text-xs text-ink-3">Cuando añadas un proxy host en NPM, el panel empezará a vigilarlo sin que hagas nada.</span>
          </span>
        </label>
      </div>
    );
    footer = (
      <>
        {instances && instances.length > 0 && (
          <Button variant="ghost" onClick={() => setStep({ kind: 'list' })}>
            Cancelar
          </Button>
        )}
        <Button variant="primary" loading={busy === 'save' || busy === 'hosts'} disabled={!form.url || !form.email || (!editing && !form.password)} onClick={() => save(editing)}>
          {editing ? 'Guardar' : 'Conectar'}
        </Button>
      </>
    );
  } else if (step.kind === 'hosts') {
    const instance = step.instance;
    body = (
      <div className="space-y-3 text-sm text-ink-2">
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => setStep({ kind: 'list' })} className="inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink">
            <ArrowLeft size={14} aria-hidden /> {instance.name}
          </button>
          <button type="button" onClick={() => showHosts(instance, true)} className="inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink" disabled={busy === 'hosts'}>
            <RefreshCw size={12} className={cn(busy === 'hosts' && 'animate-spin')} aria-hidden /> Releer de NPM
          </button>
        </div>
        <p>Marca las webs que quieres que el panel vigile. Las que ya se vigilan salen marcadas como tal.</p>
        <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
          {(hosts ?? []).map((h) =>
            (h.importable.length ? h.importable : h.domains).map((domain) => {
              const watched = h.watched.includes(domain);
              const canPick = h.enabled && h.importable.includes(domain) && !watched;
              return (
                <li key={`${h.id}-${domain}`}>
                  <label className={cn('flex items-center gap-3 px-3 py-2', canPick ? 'cursor-pointer hover:bg-white/[0.03]' : 'opacity-70')}>
                    <input
                      type="checkbox"
                      disabled={!canPick}
                      checked={watched || picked.has(domain)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(domain);
                        else next.delete(domain);
                        setPicked(next);
                      }}
                      className="size-4 shrink-0 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{domain}</span>
                      <span className="block truncate font-mono text-[11px] text-ink-3">
                        → {h.forwardHost}:{h.forwardPort}
                      </span>
                    </span>
                    {watched ? (
                      <StatusBadge tone="ok" label="Vigilada" />
                    ) : !h.enabled ? (
                      <StatusBadge tone="idle" label="Desactivada" />
                    ) : !h.online ? (
                      <StatusBadge tone="bad" label="Error en NPM" />
                    ) : !h.importable.includes(domain) ? (
                      <StatusBadge tone="idle" label="Comodín" />
                    ) : null}
                  </label>
                </li>
              );
            }),
          )}
        </ul>
      </div>
    );
    footer = (
      <Button variant="primary" loading={busy === 'import'} disabled={pendingCount === 0} onClick={() => importPicked(instance)}>
        {pendingCount ? `Vigilar ${pendingCount} ${pendingCount === 1 ? 'web' : 'webs'}` : 'Nada nuevo que vigilar'}
      </Button>
    );
  } else {
    body = (
      <div className="space-y-3">
        {(instances ?? []).map((instance) => (
          <div key={instance.id} className="rounded-[10px] border border-line px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-medium text-ink">{instance.name}</span>
              <StatusBadge tone={instance.lastError ? 'bad' : 'ok'} label={instance.lastError ? 'Sin conexión' : 'Conectado'} />
            </div>
            <p className="mt-0.5 font-mono text-[11.5px] text-ink-3">
              {instance.url} · en {titleOf(instance.serverId)}
            </p>
            <p className="mt-1 text-xs text-ink-3">
              {instance.hostsCount ?? 0} proxy hosts · leído {timeAgo(instance.syncedAt)}
              {instance.autoImport ? ' · vigila solo las webs nuevas' : ''}
            </p>
            {instance.lastError && <p className="mt-1 text-xs text-bad">{instance.lastError}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" loading={busy === 'hosts'} onClick={() => showHosts(instance)}>
                Ver sus webs
              </Button>
              <Button size="sm" variant="ghost" icon={<Pencil size={13} aria-hidden />} onClick={() => openForm(instance)}>
                Editar
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden />} onClick={() => remove(instance)}>
                Quitar
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
    footer = (
      <Button icon={<Plus size={15} aria-hidden />} onClick={() => openForm(null)}>
        Conectar otro NPM
      </Button>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Nginx Proxy Manager" description="Tus webs y a qué contenedor manda cada una" footer={footer} wide>
      {body}
      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
    </Dialog>
  );
}
