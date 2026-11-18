import { Activity, ArrowLeft, KeyRound, Lock, LogIn, ShieldCheck, User } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, type Session } from '../api';
import { Button, inputClass, useToast } from './ui';

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Segundo paso: la contraseña era correcta y falta el código del doble factor.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function handleCredentials(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session = await api.login(username, password);
      if (session.twoFactor && session.ticket) {
        setTicket(session.ticket);
        setCode('');
        setUseRecovery(false);
      } else {
        onLogin(session);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No se pudo iniciar sesión');
    } finally {
      setPassword('');
      setSubmitting(false);
    }
  }

  async function handleCode(event: React.FormEvent) {
    event.preventDefault();
    if (!ticket) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await api.loginCode(ticket, code);
      if (session.recoveryLeft !== undefined) {
        toast(
          session.recoveryLeft > 0
            ? `Has usado un código de recuperación. Te quedan ${session.recoveryLeft}.`
            : 'Has usado tu último código de recuperación. Genera otros en Seguridad.',
          session.recoveryLeft > 2 ? 'ok' : 'bad',
        );
      }
      onLogin(session);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'No se pudo comprobar el código';
      setError(message);
      setCode('');
      // El ticket ha caducado o se han agotado los intentos: vuelta a la contraseña.
      if (caught instanceof ApiError && /Vuelve a escribir la contraseña/.test(message)) setTicket(null);
    } finally {
      setSubmitting(false);
    }
  }

  function backToPassword() {
    setTicket(null);
    setCode('');
    setError(null);
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div className="bg-dot-grid pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.07] blur-[120px]" />

      <div className="relative w-full max-w-sm rounded-2xl border border-line bg-surface/90 p-7 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-accent text-black shadow-[0_0_28px_rgb(0_255_157/0.35)]">
            {ticket ? <ShieldCheck size={24} strokeWidth={2.5} aria-hidden /> : <Activity size={24} strokeWidth={2.5} aria-hidden />}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{ticket ? 'Verificación en dos pasos' : 'Server Panel'}</h1>
          <p className="label-caps mt-1.5">{ticket ? 'Segundo factor' : 'Acceso restringido'}</p>
        </div>

        {ticket ? (
          <form onSubmit={handleCode} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="login-code" className="block text-[13px] font-medium text-ink-2">
                {useRecovery ? 'Código de recuperación' : 'Código de la app de autenticación'}
              </label>
              <div className="relative">
                <KeyRound size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
                {useRecovery ? (
                  <input
                    key="recovery"
                    id="login-code"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="xxxx-xxxx"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className={`${inputClass} pl-9 font-mono tracking-wider`}
                    required
                    autoFocus
                  />
                ) : (
                  <input
                    key="totp"
                    id="login-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    placeholder="123456"
                    value={code}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setCode(digits);
                    }}
                    className={`${inputClass} pl-9 font-mono text-base tracking-[0.35em]`}
                    required
                    autoFocus
                  />
                )}
              </div>
              <p className="text-xs text-ink-3">
                {useRecovery
                  ? 'Cada código de recuperación solo sirve una vez.'
                  : 'Abre tu app (Google Authenticator, Aegis, 1Password…) y escribe el código de Server Panel.'}
              </p>
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-center text-sm text-bad">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" loading={submitting} icon={<ShieldCheck size={16} aria-hidden />} className="h-10 w-full">
              Verificar
            </Button>

            <div className="flex items-center justify-between gap-3 pt-1 text-[13px]">
              <button type="button" onClick={backToPassword} className="inline-flex items-center gap-1 text-ink-3 hover:text-ink">
                <ArrowLeft size={14} aria-hidden /> Volver
              </button>
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode('');
                  setError(null);
                }}
                className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
              >
                {useRecovery ? 'Usar la app' : 'Usar un código de recuperación'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleCredentials} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="login-user" className="block text-[13px] font-medium text-ink-2">
                Usuario
              </label>
              <div className="relative">
                <User size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
                <input
                  id="login-user"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={`${inputClass} pl-9`}
                  required
                  autoFocus
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-[13px] font-medium text-ink-2">
                Contraseña
              </label>
              <div className="relative">
                <Lock size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${inputClass} pl-9`}
                  required
                />
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-center text-sm text-bad">
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" loading={submitting} icon={<LogIn size={16} aria-hidden />} className="h-10 w-full">
              Entrar
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
