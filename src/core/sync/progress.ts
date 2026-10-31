/**
 * The "synced N of M" count for one sync pass. M comes from STATUS before any
 * folder is fetched: the uids that arrived since the last pass (all of them on
 * a first sync), capped like the fetch. Old mail that is never stored (history
 * off, or past the first-sync cap) is not counted, so a routine poll expects
 * nothing and the bar stays away. N moves as envelopes stream in.
 */
export class SyncCounter {
  private readonly perFolder = new Map<number, number>()
  private readonly finished = new Set<number>()
  private readonly current = new Map<number, number>()
  readonly expected: number

  constructor(folders: { id: number; exists: number; uidNext: number; lastUid: number }[], cap: number) {
    let sum = 0
    for (const f of folders) {
      const fresh = f.lastUid === 0 ? f.exists : f.uidNext > 0 ? f.uidNext - 1 - f.lastUid : 0
      const n = Math.min(cap, Math.max(0, fresh))
      this.perFolder.set(f.id, n)
      sum += n
    }
    this.expected = sum
  }

  fetched(folderId: number, count: number): void {
    this.current.set(folderId, Math.min(count, this.perFolder.get(folderId) ?? 0))
  }

  folderDone(folderId: number): void {
    this.finished.add(folderId)
    this.current.delete(folderId)
  }

  get done(): number {
    let n = 0
    for (const id of this.finished) n += this.perFolder.get(id) ?? 0
    for (const c of this.current.values()) n += c
    return n
  }
}
