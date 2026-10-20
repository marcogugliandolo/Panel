import { useState } from 'react';
import type { Monitor, MonitorInput } from '../../../shared/types';
import { api, ApiError } from '../../api';
import { Button, Dialog, Field, inputClass } from '../ui';

const INTERVALS = [
  { value: 30, label: 'Cada 30 segundos' },
  { value: 60, label: 'Cada minuto' },
  { value: 300, label: 'Cada 5 minutos' },
  { value: 900, label: 'Cada 15 minutos' },
  { value: 3600, label: 'Cada hora' },
];

export function MonitorDialog({
  monitor,
  onClose,
  onSaved,
}: {
  monitor: Monitor | null;
  onClose: () => void;
  onSaved: (monitor: Monitor) => void;
}) {
  const [form, setForm] = useState<Required<Pick<MonitorInput, 'name' | 'url' | 'intervalSec' | 'timeoutMs'>> & { keyword: string }>({
    name: monitor?.name ?? '',
    url: monitor?.url ?? 'https://',
    intervalSec: monitor?.intervalSec ?? 60,
    timeoutMs: monitor?.timeoutMs ?? 10_000,
    keyword: monitor?.keyword ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const input: MonitorInput = { ...form, keyword: form.keyword.trim() || null };
      const saved = monitor ? await api.updateMonitor(monitor.id, input) : await api.createMonitor(input);
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={monitor ? `Editar ${monitor.name}` : 'Añadir web'}
      description={monitor ? undefined : 'El panel comprobará que responde y avisará si se cae o si su certificado va a caducar.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="monitor-form" loading={saving}>
            {monitor ? 'Guardar' : 'Añadir y comprobar'}
          </Button>
        </>
      }
    >
      <form id="monitor-form" onSubmit={handleSubmit} className="space-y-4">
        <Field label="Nombre">
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={form.name}
              maxLength={80}
              required
              placeholder="vaixa"
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field label="URL" hint={monitor && form.url !== monitor.url ? 'Al cambiar la URL se borra el historial de esta web.' : undefined}>
          {(id) => (
            <input
              id={id}
              type="url"
              inputMode="url"
              className={`${inputClass} font-mono`}
              value={form.url}
              required
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://vaixataxi.es"
              onChange={(e) => set('url', e.target.value.trim())}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Frecuencia">
            {(id) => (
              <select id={id} className={inputClass} value={form.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))}>
                {INTERVALS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Tiempo máximo de respuesta">
            {(id) => (
              <select id={id} className={inputClass} value={form.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))}>
                {[5_000, 10_000, 20_000, 30_000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000} segundos
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label="Texto que debe aparecer (opcional)" hint="Si la página carga pero no contiene este texto, se considera caída. Útil para detectar páginas de error con código 200.">
          {(id) => (
            <input id={id} className={inputClass} value={form.keyword} maxLength={200} onChange={(e) => set('keyword', e.target.value)} />
          )}
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
