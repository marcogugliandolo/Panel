import { useEffect, useState } from 'react';
import { api, UNAUTHORIZED_EVENT, type Session } from './api';
import { Dashboard } from './components/Dashboard';
import { LoginScreen } from './components/LoginScreen';
import { ConfirmProvider, Spinner, ToastProvider } from './components/ui';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    // La versión anterior guardaba el "login" en el navegador; ya no sirve de nada.
    try {
      window.localStorage.removeItem('server_panel_auth');
    } catch {
      /* almacenamiento no disponible */
    }
    api
      .me()
      .then(setSession)
      .catch(() => setSession({ authenticated: false }));
    const onUnauthorized = () => setSession({ authenticated: false });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {session === null ? (
          <div className="flex min-h-dvh items-center justify-center">
            <Spinner label="Cargando" />
          </div>
        ) : session.authenticated ? (
          <Dashboard session={session} onLogout={() => setSession({ authenticated: false })} />
        ) : (
          <LoginScreen onLogin={setSession} />
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}
