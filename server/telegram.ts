/*
 * Cliente mínimo de la API de bots de Telegram (sin dependencias).
 * https://core.telegram.org/bots/api
 */
import { config } from './config';

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface TelegramChat {
  id: string;
  title: string;
  type: string;
}

/** Traduce los errores habituales de Telegram a algo que se entienda en el panel. */
function explain(code: number | undefined, description: string): string {
  const d = description.toLowerCase();
  if (code === 401 || code === 404) return 'Telegram no reconoce ese token. Cópialo otra vez de @BotFather.';
  if (d.includes('chat not found')) return 'Telegram no encuentra ese chat. Escribe primero al bot (pulsa «Iniciar») y vuelve a probar.';
  if (d.includes('bot was blocked')) return 'Has bloqueado el bot en Telegram. Desbloquéalo y vuelve a probar.';
  if (d.includes('bot was kicked') || d.includes('not a member')) return 'El bot ya no está en ese grupo.';
  if (code === 409) return 'El bot tiene un webhook configurado: quítalo (deleteWebhook) para poder usarlo aquí.';
  if (code === 429) return 'Telegram pide esperar un poco antes de enviar más mensajes.';
  return `Telegram: ${description}`;
}

async function call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.telegramApiUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const reason = (error as Error)?.name === 'TimeoutError' ? 'no responde' : 'no se puede alcanzar';
    throw new TelegramError(`Telegram ${reason} desde el servidor del panel.`);
  }
  const data = (await response.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; error_code?: number } | null;
  if (!data?.ok) throw new TelegramError(explain(data?.error_code ?? response.status, data?.description ?? `HTTP ${response.status}`), data?.error_code);
  return data.result as T;
}

export const isTokenLike = (token: string) => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token);

export async function getMe(token: string): Promise<{ id: number; username: string; name: string }> {
  const me = await call<{ id: number; username: string; first_name: string }>(token, 'getMe');
  return { id: me.id, username: me.username, name: me.first_name };
}

/** Chats que han escrito al bot hace poco: así no hay que buscar el chat_id a mano. */
export async function recentChats(token: string): Promise<TelegramChat[]> {
  const updates = await call<any[]>(token, 'getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message', 'my_chat_member', 'channel_post'] });
  const chats = new Map<string, TelegramChat>();
  for (const update of updates.reverse()) {
    const chat = update.message?.chat ?? update.my_chat_member?.chat ?? update.channel_post?.chat;
    if (!chat?.id) continue;
    const id = String(chat.id);
    if (chats.has(id)) continue;
    const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    chats.set(id, { id, title: chat.title || person || (chat.username ? `@${chat.username}` : id), type: chat.type });
  }
  return [...chats.values()];
}

export async function sendMessage(token: string, chatId: string, html: string, panelUrl?: string | null): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  // Telegram solo acepta botones con direcciones públicas.
  if (panelUrl && /^https:\/\//.test(panelUrl)) body.reply_markup = { inline_keyboard: [[{ text: 'Abrir el panel', url: panelUrl }]] };
  await call(token, 'sendMessage', body);
}

export const escapeHtml = (text: string) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
