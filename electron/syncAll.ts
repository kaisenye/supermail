type SyncError = { folder: string; message: string }

export type AccountSyncResult =
  | { ok: true; folders: number; messages: number; reconciled: number; errors: unknown[]; skipped: boolean }
  | { ok: false; error: string }

/**
 * Sync every account for the unified inbox. One account failing (needs a new
 * sign-in, offline) must not stop the rest: its failure is collected into
 * `errors` and the loop moves on. Only when every account failed is the
 * result a failure.
 */
export async function syncAllAccounts<A extends { accountId: number; email: string }>(
  accounts: A[],
  run: (a: A) => Promise<AccountSyncResult>
): Promise<AccountSyncResult> {
  let folders = 0
  let messages = 0
  let reconciled = 0
  const errors: unknown[] = []
  const failures: { email: string; error: string }[] = []
  for (const a of accounts) {
    const r = await run(a)
    if (!r.ok) {
      failures.push({ email: a.email, error: r.error })
      errors.push({ folder: a.email, message: r.error } satisfies SyncError)
      continue
    }
    // Another pass already holds this account (timer, focus): not a failure.
    if (r.skipped) continue
    folders += r.folders
    messages += r.messages
    reconciled += r.reconciled
    errors.push(...r.errors)
  }
  if (accounts.length > 0 && failures.length === accounts.length) {
    const error =
      failures.length === 1
        ? failures[0].error
        : failures.map((f) => `${f.email}: ${f.error}`).join('; ')
    return { ok: false, error }
  }
  return { ok: true, folders, messages, reconciled, errors, skipped: false }
}
