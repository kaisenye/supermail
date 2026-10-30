import { BrowserWindow } from 'electron'
import { runAiJobs } from '../src/core/ai/queue.js'
import { getAi } from '../src/core/services/ai/index.js'
import { ensureBody } from '../src/core/sync/fetchBody.js'
import { createAiPause, createAiTick } from './aiPause.js'
import { getAccount } from './state.js'

let timer: ReturnType<typeof setInterval> | null = null
const pause = createAiPause()

/** A new key or new AI settings may fix what paused the queue: try again on the next tick. */
export function resumeAiWorker(): void {
  pause.clear()
}

/**
 * Precomputed AI (Scape): works through ai_jobs while the app runs. One run at
 * a time. A missing key just ends the run; a rejected key or rate limit pauses
 * the queue for a while, a spent budget until local midnight (see aiPause.ts).
 */
export function startAiWorker(intervalMs = 15_000): void {
  if (timer) return
  const tick = createAiTick({
    pause,
    run: () =>
      runAiJobs({
        ai: getAi(),
        ensureBody: async (accountId, rowId) => {
          const a = getAccount(accountId)
          if (a) await ensureBody(accountId, a.config, rowId).catch(() => undefined)
        }
      }),
    notify: (kinds) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:updated', { kinds })
    }
  })
  void tick()
  timer = setInterval(() => void tick(), intervalMs)
}
