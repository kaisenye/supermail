/**
 * The "synced N of M" count for one sync pass. M comes from STATUS before any
 * folder is fetched: what each folder holds beyond what is stored, capped like
 * the fetch. N moves as envelopes stream in, so a 20 000-message first sync
 * shows movement long before the first folder finishes.
 */
export class SyncCounter {
  private readonly perFolder = new Map<number, number>()
  private readonly finished = new Set<number>()
  private readonly current = new Map<number, number>()
  readonly expected: number

  constructor(folders: { id: number; exists: number; local: number }[], cap: number) {
    let sum = 0
    for (const f of folders) {
      const n = Math.min(cap, Math.max(0, f.exists - f.local))
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
