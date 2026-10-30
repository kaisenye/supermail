/**
 * Service registry. The AI service (Phase 4) lives in ./ai: main builds it with
 * initAi() and the renderer reaches it only through electron/ipcAi.ts. No UI
 * code imports an AI module directly.
 */
export type Service<I = unknown, O = unknown> = (input: I) => Promise<O>

const services = new Map<string, Service>()

export function registerService(name: string, fn: Service): void {
  services.set(name, fn)
}

export function getService<I, O>(name: string): Service<I, O> | undefined {
  return services.get(name) as Service<I, O> | undefined
}

export function hasService(name: string): boolean {
  return services.has(name)
}

export function listServices(): string[] {
  return [...services.keys()]
}
