import { createAi, type Ai, type AiDeps } from './service.js'

let instance: Ai | null = null

/** Main calls this once at boot, after the DB and the vault are ready. */
export function initAi(deps: AiDeps): Ai {
  instance = createAi(deps)
  return instance
}

export function getAi(): Ai {
  if (!instance) throw new Error('AI service not initialised')
  return instance
}
