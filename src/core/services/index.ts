/**
 * Service registry — AI socket #2. Empty in stage 1.
 *
 * Stage 2 registers summarize/semanticSearch/suggestReply here and the UI
 * resolves them by name, so no UI code imports an AI module directly.
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
