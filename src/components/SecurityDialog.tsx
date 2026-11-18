import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, type TwoFactorSetup, type TwoFactorStatus } from '../api';
import { Button, Dialog, Field, Spinner, StatusBadge, inputClass, useToast } from './ui';

type Step =
  | { kind: 'status' }
  | { kind: 'setup'; setup: TwoFactorSetup }
  | { kind: 'codes'; codes: string[]; fresh: boolean }
  | { kind: 'disable' }
  | { kind: 'regenerate' };

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

/** Seguridad de la cuenta: activar o desactivar el doble factor y gestionar los códigos de recuperación. */
export function SecurityDialog({ open, onClose, username }: { open: boolean; onClose: () => void; username?: string }) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'status' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setStep({ kind: 'status' });
    setStatus(null);
    setError(null);
    api
      .twoFactor()
      .then(setStatus)
      .catch((caught) => setError(errorText(caught, 'No se pudo leer el estado')));
  }, [open]);

  function reset(next: Step) {
    setCode('');
    setPassword('');
    setError(null);
    setStep(next);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, 'Algo ha fallado'));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const startSetup = () => run(async () => reset({ kind: 'setup', setup: await api.twoFactorSetup() }));
  const confirmSetup = () =>
    run(async () => {
      const { recoveryCodes, closedSessions } = await api.twoFactorEnable(code);
      setStatus(await api.twoFactor());
      reset({ kind: 'codes', codes: recoveryCodes, fresh: true });
      toast(closedSessions > 0 ? `Doble factor activado. Se han cerrado ${closedSessions} sesiones abiertas en otros sitios.` : 'Doble factor activado.');
    });
  const disable = () =>
    run(async () => {
      setStatus(await api.twoFactorDisable(password, code));
      reset({ kind: 'status' });
      toast('Doble factor desactivado.', 'bad');
    });
  const regenerate = () =>
    run(async () => {
      const { recoveryCodes } = await api.twoFactorRecovery(code);
      setStatus(await api.twoFactor());
      reset({ kind: 'codes', codes: recoveryCodes, fresh: false });
    });

  const codeInput = (onEnter?: () => void) => (
    <Field label="Código de la app" hint="Los 6 dígitos que muestra ahora mismo la app.">
      {(id) => (
        <input
          id={id}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.length === 6 && onEnter) onEnter();
          }}
          className={`${inputClass} max-w-[180px] font-mono text-base tracking-[0.35em]`}
          autoFocus
        />
      )}
    </Field>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (!status && !error) {
    body = (
      <div className="flex justify-center py-8">
        <Spinner label="Cargando" />
      </div>
    );
  } else if (step.kind === 'status') {
    body = status?.enabled ? (
      <div className="space-y-4 text-sm text-ink-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="ok" label="Doble factor activado" />
          {status.enabledAt && <span className="text-xs text-ink-3">desde el {new Date(status.enabledAt).toLocaleDateString('es-ES', { dateStyle: 'long' })}</span>}
        </div>
        <p>
          Para entrar en el panel hace falta la contraseña y el código de tu app. Te quedan{' '}
          <b className={status.recoveryLeft <= 2 ? 'text-warn' : 'text-ink'}>{status.recoveryLeft} códigos de recuperación</b>
          {status.recoveryLeft <= 2 && ': genera otros antes de que se acaben'}.
        </p>
      </div>
    ) : (
      <div className="space-y-4 text-sm text-ink-2">
        <StatusBadge tone="warn" label="Solo contraseña" />
        <p>
          Desde este panel se arrancan y paran contenedores, así que conviene pedir algo más que la contraseña. Con el doble factor, además de
          la contraseña tendrás que escribir un código de 6 cifras que genera una app del móvil (Google Authenticator, Aegis, 1Password,
          Bitwarden…).
        </p>
        <p className="text-ink-3">Al activarlo se cerrarán las sesiones abiertas en otros navegadores.</p>
      </div>
    );
    footer = status?.enabled ? (
      <>
        <Button variant="danger" icon={<ShieldOff size={15} aria-hidden />} onClick={() => reset({ kind: 'disable' })}>
          Desactivar
        </Button>
        <Button icon={<KeyRound size={15} aria-hidden />} onClick={() => reset({ kind: 'regenerate' })}>
          Nuevos códigos de recuperación
        </Button>
      </>
    ) : status ? (
      <Button variant="primary" loading={busy} icon={<ShieldCheck size={15} aria-hidden />} onClick={startSetup}>
        Activar doble factor
      </Button>
    ) : null;
  } else if (step.kind === 'setup') {
    body = (
      <div className="space-y-5 text-sm text-ink-2">
        <ol className="list-decimal space-y-1 pl-5">
          <li>En la app del móvil, añade una cuenta nueva escaneando este código.</li>
          <li>Escribe abajo el código de 6 cifras que te muestre para confirmar.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-5">
          <img src={step.setup.qr} alt="Código QR para añadir Server Panel a tu app de autenticación" className="size-44 rounded-lg bg-white p-1.5" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs text-ink-3">¿No puedes escanearlo? Escribe esta clave a mano (tipo «basada en tiempo»):</p>
            <code className="block rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] break-words text-ink select-all">
              {step.setup.secret}
            </code>
            <p className="text-xs text-ink-3">Cuenta: Server Panel{username ? ` (${username})` : ''}</p>
          </div>
        </div>
        {codeInput(confirmSetup)}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => reset({ kind: 'status' })}>
          Cancelar
        </Button>
        <Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={confirmSetup}>
          Confirmar y activar
        </Button>
      </>
    );
  } else if (step.kind === 'codes') {
    const text = step.codes.join('\n');
    body = (
      <div className="space-y-4 text-sm text-ink-2">
        <p>
          {step.fresh ? 'Listo. ' : ''}Guarda estos <b className="text-ink">códigos de recuperación</b> en un sitio seguro (el gestor de contraseñas, por
          ejemplo). Si pierdes el móvil, cada uno te deja entrar <b className="text-ink">una sola vez</b> en lugar del código de la app.
          {!step.fresh && ' Los anteriores ya no sirven.'}
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-bg p-3 font-mono text-[14px] text-ink">
          {step.codes.map((c) => (
            <li key={c} className="text-center tracking-wider">
              {c}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-3">No se volverán a mostrar.</p>
      </div>
    );
    footer = (
      <>
        <Button
          icon={<Copy size={15} aria-hidden />}
          onClick={() =>
            navigator.clipboard
              .writeText(text)
              .then(() => toast('Códigos copiados'))
              .catch(() => toast('No se pudieron copiar', 'bad'))
          }
        >
          Copiar
        </Button>
        <Button
          icon={<Download size={15} aria-hidden />}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`Server Panel · códigos de recuperación\n\n${text}\n`], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'server-panel-codigos-recuperacion.txt';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Descargar
        </Button>
        <Button variant="primary" onClick={() => reset({ kind: 'status' })}>
          Ya los he guardado
        </Button>
      </>
    );
  } else if (step.kind === 'disable') {
    body = (
      <div className="space-y-4 text-sm text-ink-2">
        <p>Para desactivarlo confirma con la contraseña y un código de la app (o uno de recuperación si no tienes el móvil).</p>
        <Field label="Contraseña">
          {(id) => (
            <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} autoFocus />
          )}
        </Field>
        <Field label="Código de la app o de recuperación">
          {(id) => (
            <input
              id={id}
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${inputClass} max-w-[220px] font-mono tracking-wider`}
            />
          )}
        </Field>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => reset({ kind: 'status' })}>
          Cancelar
        </Button>
        <Button variant="danger" loading={busy} disabled={!password || !code} onClick={disable}>
          Desactivar doble factor
        </Button>
      </>
    );
  } else {
    body = (
      <div className="space-y-4 text-sm text-ink-2">
        <p>Se crearán 10 códigos nuevos y los que tengas ahora dejarán de servir.</p>
        {codeInput(regenerate)}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => reset({ kind: 'status' })}>
          Cancelar
        </Button>
        <Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={regenerate}>
          Generar códigos
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        // Mientras se ven los códigos recién creados, cerrar equivale a "ya los he guardado".
        onClose();
      }}
      title="Seguridad"
      description="Doble factor para entrar en el panel"
      footer={footer}
    >
      {body}
      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
    </Dialog>
  );
}
