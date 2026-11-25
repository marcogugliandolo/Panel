import { ChevronDown, Plus, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type DiscoveryCandidate, type DiscoveryState } from '../../api';
import { timeAgo } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button, Dialog, StatusBadge, inputClass, useToast } from '../ui';

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

/**
 * Webs tuyas que aún no se vigilan: salen de los registros públicos de certificados (todas las que han tenido
 * HTTPS) y de Nginx Proxy Manager. Se marcan por defecto las que responden.
 */
export function DiscoveryDialog({
  open,
  onClose,
  state,
  onState,
  onWatched,
}: {
  open: boolean;
  onClose: () => void;
  state: DiscoveryState | null;
  onState: (state: DiscoveryState) => void;
  onWatched: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showGone, setShowGone] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const alive = useMemo(() => (state?.candidates ?? []).filter((c) => c.responds), [state]);
  const silent = useMemo(() => (state?.candidates ?? []).filter((c) => c.resolves && !c.responds), [state]);
  const gone = useMemo(() => (state?.candidates ?? []).filter((c) => !c.resolves), [state]);

  // Al abrir (o al terminar una búsqueda), se marcan las que responden.
  const key = `${state?.lastRun ?? 0}-${alive.length}`;
  useEffect(() => {
    if (open) setPicked(new Set(alive.map((c) => c.host)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

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

  const search = () => run('search', async () => onState(await api.discoveryRun()));
  const watch = () =>
    run('watch', async () => {
      const result = await api.discoveryWatch([...picked]);
      onState(result);
      toast(result.added.length ? `Se vigilan ${result.added.length} webs más` : 'Ya se vigilaban todas');
      onWatched();
      if (!result.candidates.some((c) => c.responds)) onClose();
    });
  const dismiss = (host: string) => run(`dismiss:${host}`, async () => onState(await api.discoveryDismiss([host])));
  const addDomain = () =>
    run('domain', async () => {
      const list = [...(state?.extraDomains ?? []), newDomain.trim()];
      onState(await api.discoveryDomains(list));
      setNewDomain('');
    });

  const row = (c: DiscoveryCandidate) => {
    const checkable = c.resolves;
    return (
      <li key={c.host} className="flex items-center gap-3 px-3 py-2">
        <input
          type="checkbox"
          disabled={!checkable}
          checked={picked.has(c.host)}
          onChange={(e) => {
            const next = new Set(picked);
            if (e.target.checked) next.add(c.host);
            else next.delete(c.host);
            setPicked(next);
          }}
          aria-label={`Vigilar ${c.host}`}
          className="size-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{c.host}</span>
          <span className="block truncate text-[11px] text-ink-3">
            {c.source === 'npm' ? 'En Nginx Proxy Manager' : `Certificado ${c.certAt ? timeAgo(c.certAt) : ''}`}
            {c.responds ? ` · responde ${c.status}` : c.resolves ? ' · no responde' : ' · el dominio ya no existe'}
          </span>
        </span>
        <StatusBadge tone={c.responds ? (c.status && c.status >= 500 ? 'warn' : 'ok') : c.resolves ? 'warn' : 'idle'} label={c.responds ? 'Responde' : c.resolves ? 'Sin respuesta' : 'No existe'} />
        <button
          type="button"
          onClick={() => dismiss(c.host)}
          disabled={busy === `dismiss:${c.host}`}
          className="shrink-0 rounded-md p-1 text-ink-3 hover:bg-white/5 hover:text-ink"
          aria-label={`No proponer más ${c.host}`}
          title="No proponerla más"
        >
          <X size={14} aria-hidden />
        </button>
      </li>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Buscar tus webs"
      description="Todas las que han tenido HTTPS en tus dominios, más las de Nginx Proxy Manager"
      wide
      footer={
        <>
          <Button variant="ghost" icon={<RefreshCw size={14} className={cn(state?.running && 'animate-spin')} aria-hidden />} loading={busy === 'search'} disabled={state?.running} onClick={search}>
            {state?.running ? 'Buscando…' : 'Buscar de nuevo'}
          </Button>
          <Button variant="primary" loading={busy === 'watch'} disabled={!picked.size} onClick={watch}>
            {picked.size ? `Vigilar ${picked.size} ${picked.size === 1 ? 'web' : 'webs'}` : 'Marca alguna web'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-ink-2">
        <p className="text-[12.5px] text-ink-3">
          Cada certificado HTTPS queda apuntado en registros públicos (Certificate Transparency). El panel los consulta desde tu servidor para tus dominios,
          comprueba cuáles existen y responden, y te propone las que aún no vigilas. Se repite solo una vez al día.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ink-3">Dominios:</span>
          {(state?.domains ?? []).map((d) => (
            <span key={d} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-ink-2">
              {d}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && newDomain.trim() && addDomain()}
              placeholder="otro-dominio.es"
              aria-label="Añadir otro dominio"
              className={cn(inputClass, 'h-7 w-40 px-2 py-0 font-mono text-[12px]')}
            />
            <button
              type="button"
              onClick={addDomain}
              disabled={!newDomain.trim() || busy === 'domain'}
              className="rounded-md border border-line p-1 text-ink-2 hover:bg-white/5 disabled:opacity-40"
              aria-label="Añadir dominio"
            >
              <Plus size={14} aria-hidden />
            </button>
          </span>
        </div>

        {state?.running && !state.candidates.length ? (
          <p className="rounded-lg border border-line bg-bg px-3 py-3 text-[13px] text-ink-3">Buscando en los registros de certificados… (puede tardar un minuto)</p>
        ) : !state?.lastRun ? (
          <p className="rounded-lg border border-line bg-bg px-3 py-3 text-[13px] text-ink-3">Aún no se ha buscado. Pulsa «Buscar de nuevo».</p>
        ) : alive.length + silent.length + gone.length === 0 ? (
          <p className="rounded-lg border border-line bg-bg px-3 py-3 text-[13px] text-ink-3">No hay webs nuevas: ya vigilas todas las que aparecen.</p>
        ) : (
          <>
            {alive.length > 0 && (
              <section>
                <h4 className="mb-1.5 text-[12.5px] font-medium text-ink-2">Responden ({alive.length})</h4>
                <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">{alive.map(row)}</ul>
              </section>
            )}
            {silent.length > 0 && (
              <section>
                <h4 className="mb-1.5 text-[12.5px] font-medium text-ink-2">Existen pero no responden ({silent.length})</h4>
                <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">{silent.map(row)}</ul>
              </section>
            )}
            {gone.length > 0 && (
              <section>
                <button type="button" onClick={() => setShowGone((v) => !v)} className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
                  <ChevronDown size={14} className={cn('transition-transform', showGone && 'rotate-180')} aria-hidden /> Antiguas, el dominio ya no existe ({gone.length})
                </button>
                {showGone && <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-[10px] border border-line opacity-70">{gone.map(row)}</ul>}
              </section>
            )}
          </>
        )}
        {(error || state?.lastError) && (
          <p role="alert" className="rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-[13px] text-bad">
            {error ?? state?.lastError}
          </p>
        )}
        {state?.lastRun && <p className="text-[11.5px] text-ink-3">Última búsqueda {timeAgo(state.lastRun)}{state.sources.length ? ` · fuente: ${state.sources.join(', ')}` : ''}</p>}
      </div>
    </Dialog>
  );
}
