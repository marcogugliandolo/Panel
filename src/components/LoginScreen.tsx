import { Activity, Lock, LogIn, User } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, type Session } from '../api';
import { Button, inputClass } from './ui';

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onLogin(await api.login(username, password));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No se pudo iniciar sesión');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div className="bg-dot-grid pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.07] blur-[120px]" />

      <div className="relative w-full max-w-sm rounded-2xl border border-line bg-surface/90 p-7 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-accent text-black shadow-[0_0_28px_rgb(0_255_157/0.35)]">
            <Activity size={24} strokeWidth={2.5} aria-hidden />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Server Panel</h1>
          <p className="label-caps mt-1.5">Acceso restringido</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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
      </div>
    </main>
  );
}
