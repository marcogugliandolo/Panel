import { ExternalLink, RefreshCw, Send, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, type NotifyRules, type NotifyStatus, type TelegramChat } from '../api';
import { timeAgo } from '../lib/format';
import { Button, Dialog, Field, Spinner, StatusBadge, inputClass, useToast } from './ui';

const RULES: { key: keyof NotifyRules; label: string; hint: string }[] = [
  { key: 'servers', label: 'Servidores sin respuesta', hint: 'Cuando un servidor deja de enviar datos y cuando vuelve.' },
  { key: 'containers', label: 'Contenedores parados o caídos', hint: 'Cuando uno que estaba en marcha se para, se cae o se reinicia sin parar. Las tareas puntuales que terminan solas no avisan.' },
  { key: 'manualStops', label: 'También lo que pares tú desde el panel', hint: 'Si está desactivado, lo que pares con los botones del panel no avisa (sí lo que pares desde Portainer o la terminal).' },
  { key: 'webs', label: 'Webs caídas', hint: 'Dos comprobaciones fallidas seguidas, y cuando vuelven.' },
  { key: 'certs', label: 'Certificados SSL', hint: 'A 14, 7, 3 y 1 día de caducar, y cuando se renuevan.' },
  { key: 'resources', label: 'CPU, RAM o disco altos', hint: 'Si pasan del umbral durante 5 minutos seguidos.' },
];

const errorText = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);
/** Las líneas vienen preparadas para Telegram (HTML): aquí se muestran como texto. */
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Conexión del panel con un bot de Telegram para avisar de lo que se cae. */
export function TelegramDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [token, setToken] = useState('');
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [changingBot, setChangingBot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setError(null);
    setToken('');
    setChats(null);
    setChangingBot(false);
    api
      .notify()
      .then(setStatus)
      .catch((caught) => setError(errorText(caught, 'No se pudo leer la configuración')));
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

  const saveBot = () =>
    run('bot', async () => {
      setStatus(await api.notifyBot(token));
      setToken('');
      setChats(null);
      setChangingBot(false);
    });

  const connect = (chat: TelegramChat) =>
    run('chat', async () => {
      setStatus(await api.notifyChat(chat));
      setChats(null);
      toast('Telegram conectado: te ha llegado un mensaje con el estado actual.');
    });

  const findChats = () =>
    run('chats', async () => {
      const found = await api.notifyChats();
      if (found.length === 0) {
        setChats([]);
        setError('Todavía no le has escrito al bot. Ábrelo en Telegram, pulsa «Iniciar» y vuelve a probar.');
        return;
      }
      if (found.length === 1) {
        setStatus(await api.notifyChat(found[0]));
        setChats(null);
        toast('Telegram conectado: te ha llegado un mensaje con el estado actual.');
        return;
      }
      setChats(found);
    });

  const toggle = (key: keyof NotifyRules, value: boolean) =>
    run(`rule:${key}`, async () => {
      setStatus(await api.notifyRules({ [key]: value }));
    });

  const test = () =>
    run('test', async () => {
      setStatus(await api.notifyTest());
      toast('Mensaje de prueba enviado');
    });

  const disconnect = () =>
    run('off', async () => {
      setStatus(await api.notifyDisconnect());
      toast('Telegram desconectado', 'bad');
    });

  const fromEnv = status?.source === 'env';
  const needsBot = status && !fromEnv && (!status.hasToken || changingBot);
  const needsChat = status && !needsBot && !status.active;

  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (!status) {
    body = error ? null : (
      <div className="flex justify-center py-8">
        <Spinner label="Cargando" />
      </div>
    );
  } else if (needsBot) {
    body = (
      <div className="space-y-4 text-sm text-ink-2">
        <p>El panel te escribirá por Telegram cuando se caiga un servidor, un contenedor o una web, y cuando vuelva. Funciona aunque no tengas el panel abierto.</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            En Telegram, abre{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2 hover:text-accent">
              @BotFather
            </a>
            , envía <code className="rounded bg-white/5 px-1 font-mono text-[12.5px] text-ink">/newbot</code> y elige un nombre (por ejemplo «Panel de Marco»).
          </li>
          <li>Te dará un token. Pégalo aquí.</li>
        </ol>
        <Field label="Token del bot">
          {(id) => (
            <input
              id={id}
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              onKeyDown={(e) => e.key === 'Enter' && token && saveBot()}
              placeholder="123456789:AAH…"
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} font-mono text-[13px]`}
              autoFocus
            />
          )}
        </Field>
      </div>
    );
    footer = (
      <>
        {changingBot && (
          <Button variant="ghost" onClick={() => setChangingBot(false)}>
            Cancelar
          </Button>
        )}
        <Button variant="primary" loading={busy === 'bot'} disabled={!token} onClick={saveBot}>
          Comprobar bot
        </Button>
      </>
    );
  } else if (needsChat) {
    const botUrl = status.bot ? `https://t.me/${status.bot.username}` : null;
    body = (
      <div className="space-y-4 text-sm text-ink-2">
        <p>
          Bot listo: <b className="text-ink">{status.bot ? `@${status.bot.username}` : 'tu bot'}</b>. Ahora dile dónde escribirte:
        </p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            Abre el bot en Telegram y pulsa <b className="text-ink">Iniciar</b> (o envíale cualquier mensaje). Si prefieres que avise en un grupo, añádelo al grupo y escribe algo allí.
          </li>
          <li>Vuelve aquí y pulsa «Ya le he escrito».</li>
        </ol>
        {botUrl && (
          <a
            href={botUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-white/5"
          >
            <ExternalLink size={14} aria-hidden /> Abrir @{status.bot!.username}
          </a>
        )}
        {chats && chats.length > 1 && (
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-ink-2">Han escrito al bot varios chats. ¿Cuál es el tuyo?</p>
            <ul className="space-y-1.5">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    disabled={busy === 'chat'}
                    onClick={() => connect(chat)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-accent/50 hover:bg-white/5"
                  >
                    <span className="text-ink">{chat.title}</span>
                    <span className="text-xs text-ink-3">{chat.type === 'private' ? 'Chat privado' : 'Grupo'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => setChangingBot(true)}>
          Usar otro bot
        </Button>
        <Button variant="primary" loading={busy === 'chats' || busy === 'chat'} icon={<RefreshCw size={15} aria-hidden />} onClick={findChats}>
          Ya le he escrito
        </Button>
      </>
    );
  } else {
    body = (
      <div className="space-y-5 text-sm text-ink-2">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={status.lastError ? 'bad' : 'ok'} label={status.lastError ? 'No se pudo enviar el último aviso' : 'Conectado'} />
            {status.lastSentAt && <span className="text-xs text-ink-3">último mensaje {timeAgo(status.lastSentAt)}</span>}
          </div>
          <p>
            Avisa a <b className="text-ink">{status.chat?.title}</b>
            {status.bot && (
              <>
                {' '}
                con <b className="text-ink">@{status.bot.username}</b>
              </>
            )}
            {fromEnv && ' (configurado con variables del stack)'}.
          </p>
          {status.lastError && <p className="text-[13px] text-bad">{status.lastError}</p>}
        </div>

        <fieldset className="space-y-1">
          <legend className="mb-2 text-[13px] font-medium text-ink-2">Qué avisar</legend>
          {RULES.map((rule) => (
            <label key={rule.key} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.03]">
              <input
                type="checkbox"
                checked={status.rules[rule.key]}
                disabled={busy === `rule:${rule.key}`}
                onChange={(e) => toggle(rule.key, e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-ink">{rule.label}</span>
                <span className="block text-xs text-ink-3">{rule.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="space-y-1.5">
          <p className="text-[13px] font-medium text-ink-2">Ahora mismo</p>
          {status.problems.length === 0 ? (
            <p className="text-ink-3">Todo en orden: no hay nada caído.</p>
          ) : (
            <ul className="space-y-1 rounded-lg border border-line bg-bg px-3 py-2 text-[13px]">
              {status.problems.map((p) => (
                <li key={p}>{plain(p)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
    footer = (
      <>
        {!fromEnv && (
          <Button variant="danger" loading={busy === 'off'} icon={<Unplug size={15} aria-hidden />} onClick={disconnect}>
            Desconectar
          </Button>
        )}
        <Button variant="primary" loading={busy === 'test'} icon={<Send size={15} aria-hidden />} onClick={test}>
          Enviar prueba
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Avisos por Telegram" description="Te escribe cuando algo se cae y cuando vuelve" footer={footer}>
      {body}
      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-bad/25 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}
    </Dialog>
  );
}
