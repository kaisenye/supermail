import { ipcMain } from 'electron'
import { displayNameFor } from '../src/core/accounts/manage.js'
import { askMail } from '../src/core/ai/ask.js'
import { threadInsights } from '../src/core/ai/insights.js'
import { suggestRepliesOnce } from '../src/core/ai/replies.js'
import { summarizeThreadOnce } from '../src/core/ai/summary.js'
import { getAi } from '../src/core/services/ai/index.js'
import { clearAiKey, saveAiKey } from '../src/core/services/ai/keys.js'
import type { AiConfigInput } from '../src/core/services/ai/settings.js'
import { AiError, type AiProviderId } from '../src/core/services/ai/types.js'
import { clearClassifications } from '../src/core/store/ai.js'
import { clearMessageLabels, deleteAiLabel, listAiLabels, queueLabelBackfill, saveAiLabel } from '../src/core/store/aiLabels.js'
import { getMessage, getSettings, getThread, setSetting } from '../src/core/store/repo.js'
import { ensureBody } from '../src/core/sync/fetchBody.js'
import { aiFail, aiWrite, createAiHandlers, type AiWriteInput } from './aiHandlers.js'
import { resumeAiWorker } from './aiWorker.js'
import { getAccount, getBootState, listAccounts, type LiveAccount } from './state.js'

export { aiFail } from './aiHandlers.js'

/** The account a renderer call names, or the active one. */
function owner(accountId?: number | null): LiveAccount | null {
  if (accountId != null) return getAccount(accountId)
  const s = getBootState()
  return s.ok ? getAccount(s.accountId) : null
}

/** Bodies a feature needs; a failed fetch leaves the snippet to stand in. */
async function ensureBodies(accountId: number, ids: number[]): Promise<void> {
  const a = getAccount(accountId)
  if (!a) return
  for (const id of ids) await ensureBody(accountId, a.config, id).catch(() => undefined)
}

/** Phase 4 handlers. Bodies live in `aiHandlers.ts`; this only wires them to IPC and main's stores. */
export function registerAiIpc(): void {
  const h = createAiHandlers({
    status: () => getAi().status(),
    settings: getSettings,
    setSetting,
    saveKey: saveAiKey,
    clearKey: clearAiKey,
    clearClassifications: () => {
      clearClassifications()
      clearMessageLabels()
    }
  })
  ipcMain.handle('ai:status', () => getAi().status())
  // A new key or new settings (a raised budget, another provider) may fix what
  // paused the background queue, so it tries again on its next tick.
  const resumeIfOk = <T extends { ok: boolean }>(r: T): T => {
    if (r.ok) resumeAiWorker()
    return r
  }
  ipcMain.handle('ai:setKey', (_e, provider: AiProviderId, key: string) => resumeIfOk(h.setKey(provider, key)))
  ipcMain.handle('ai:clearKey', (_e, provider: AiProviderId) => h.clearKey(provider))
  ipcMain.handle('ai:setConfig', (_e, input: AiConfigInput) => resumeIfOk(h.setConfig(input)))
  ipcMain.handle('ai:write', (_e, input: AiWriteInput) =>
    aiWrite({ ai: getAi(), message: getMessage, thread: getThread, displayName: displayNameFor }, input)
  )

  // An inbox's own labels (Settings → AI). Saving one re-sorts that inbox's
  // last 14 days in the background, when the classifier is on.
  ipcMain.handle('ai:labels', (_e, accountId: number) => listAiLabels(accountId))
  ipcMain.handle('ai:saveLabel', (_e, input: { id?: number; accountId: number; name: string; description: string }) => {
    try {
      if (!getAccount(input.accountId)) throw new Error('No such inbox')
      const label = saveAiLabel(input)
      if (getAi().status().features.classify) queueLabelBackfill(input.accountId)
      return { ok: true as const, label }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('ai:deleteLabel', (_e, id: number) => {
    const label = deleteAiLabel(id)
    return { ok: true as const, label }
  })

  // Store reads only: never calls a provider. No account (-1) reads as "nothing stored".
  ipcMain.handle('ai:insights', (_e, threadId: string, accountId?: number) => {
    const features = getAi().status().features
    return { features, ...threadInsights(owner(accountId)?.accountId ?? -1, threadId, features) }
  })

  ipcMain.handle('ai:summarize', async (_e, threadId: string, accountId?: number) => {
    try {
      const a = owner(accountId)
      if (!a) throw new AiError('invalid', 'No account for this conversation')
      const r = await summarizeThreadOnce({ ai: getAi(), ensureBodies }, a.accountId, threadId)
      return { ok: true as const, summary: r.summary }
    } catch (e) {
      return aiFail(e)
    }
  })

  // On demand, for an older conversation the worker never saw. Cached after.
  ipcMain.handle('ai:suggestReplies', async (_e, threadId: string, accountId?: number) => {
    try {
      const a = owner(accountId)
      if (!a) throw new AiError('invalid', 'No account for this conversation')
      const target = threadInsights(a.accountId, threadId, getAi().status().features).replyTarget
      if (!target) return { ok: true as const, replies: null }
      await ensureBodies(a.accountId, [target])
      const options = await suggestRepliesOnce(getAi(), target, { background: false })
      return { ok: true as const, replies: { messageRowId: target, options } }
    } catch (e) {
      return aiFail(e)
    }
  })

  // Every connected account's local mail; only the matching messages go to the provider.
  ipcMain.handle('ai:ask', async (_e, question: string) => {
    try {
      const r = await askMail(getAi(), listAccounts().map((a) => a.accountId), String(question ?? ''))
      return { ok: true as const, ...r }
    } catch (e) {
      return aiFail(e)
    }
  })
}
