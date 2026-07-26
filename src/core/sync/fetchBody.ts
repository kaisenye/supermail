import type { AccountConfig } from '../accounts/config.js'
import { processors } from '../pipeline/index.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { getMessage, getMessageLocation } from '../store/repo.js'
import type { Message } from '../store/types.js'
import { createClient, fetchSource } from './imap.js'

/**
 * Lazily fetches one message body. Returns immediately from cache when the
 * body is already stored — opening a thread twice must never hit the network.
 */
export async function ensureBody(
  accountId: number,
  config: AccountConfig,
  messageId: number
): Promise<Message | undefined> {
  const loc = getMessageLocation(messageId)
  if (!loc) return getMessage(messageId)
  if (loc.body_fetched === 1) return getMessage(messageId)

  const client = createClient(config)
  await client.connect()
  try {
    const source = await fetchSource(client, loc.path, loc.uid)
    if (!source) return getMessage(messageId)

    // folderId must match the stored row: the upsert keys on
    // (account_id, folder_id, uid), so a null here would insert a draft
    // instead of filling in the existing message's body.
    await runPipeline(
      { accountId, folderId: loc.folder_id, uid: loc.uid, source },
      processors
    )
  } finally {
    await client.logout().catch(() => {})
  }

  return getMessage(messageId)
}
