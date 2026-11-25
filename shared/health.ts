import type { ContainerInfo } from './types';

/** Código de salida de un contenedor parado («Exited (137) 2 minutes ago» → 137). */
export function exitCode(container: Pick<ContainerInfo, 'status'>): number | null {
  const match = /exited \((\d+)\)/i.exec(container.status ?? '');
  return match ? Number(match[1]) : null;
}

/** Un contenedor parado limpiamente (código 0) no es un problema: suele ser una tarea puntual. */
export function isContainerProblem(container: Pick<ContainerInfo, 'state' | 'status'>): boolean {
  if (container.state === 'restarting' || container.state === 'dead') return true;
  if (container.state === 'exited') {
    const code = exitCode(container);
    return code !== null && code !== 0;
  }
  return false;
}
