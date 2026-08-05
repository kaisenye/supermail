import type { AccountConfig } from '../accounts/config.js'
import { processors } from '../pipeline/index.js'
import { runPipeline } from '../pipeline/pipeline.js'
import { getMessage, getMessageLocation } from '../store/repo.js'
import type { Message } from '../store/types.js'
import { fetchSource } from './imap.js'
import { getPool } from './pool.js'

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

  // Pooled: this used to open a connection per message, so opening an
  // unfetched message cost a full ~5s cold round trip.
  await getPool(config).withConnection(async (client) => {
    const source = await fetchSource(client, loc.path, loc.uid)
    if (!source) return

    // folderId must match the stored row: the upsert keys on
    // (account_id, folder_id, uid), so a null here would insert a draft
    // instead of filling in the existing message's body.
    await runPipeline(
      { accountId, folderId: loc.folder_id, uid: loc.uid, source },
      processors
    )
  })

  return getMessage(messageId)
}
