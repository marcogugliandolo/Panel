// Encargos que se hacen desde el panel (reiniciar un contenedor, comprobar una web…).
// Quien ejecuta la acción avisa al empezar y al terminar; la oficina y el edificio lo
// escuchan para animar la entrega y anotarlo en el registro de actividad.

export interface OrderEvent {
  /** Identificador del encargo, el mismo al empezar y al terminar. */
  id: string;
  /** Id del servidor (el de SERVER_ID) o "reception" para las webs. */
  serverId: string;
  /** Lo que se pide, en infinitivo: "Reiniciar pihole". */
  label: string;
  /** Lo que se ve mientras se hace: "Reiniciando pihole". */
  doing: string;
  phase: 'start' | 'done';
  ok?: boolean;
  /** Resultado al terminar: "pihole reiniciado" o el error. */
  result?: string;
}

const EVENT = 'panel:order';

export function emitOrder(event: OrderEvent) {
  window.dispatchEvent(new CustomEvent<OrderEvent>(EVENT, { detail: event }));
}

export function onOrder(listener: (event: OrderEvent) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<OrderEvent>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

export const newOrderId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
