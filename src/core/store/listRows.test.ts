import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeDb, getDb, initDb } from './db.js'
import {
  countView,
  listView,
  markDirtyByMessageId,
  REBUILD_SQL,
  refreshListRows,
  repairListDrift
} from './listRows.js'
import { deleteMessageLocal, moveMessage, restoreMessage, setFlags, upsertMessage } from './repo.js'

const ACC = 1
const ME = 'me@x.test'
let inbox: number
let archive: number
let uid = 0

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'listrows-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare('INSERT INTO accounts (id,email) VALUES (?,?)').run(ACC, ME)
  const ins = db.prepare('INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)')
  inbox = Number(ins.run(ACC, 'INBOX', 'INBOX', 'inbox').lastInsertRowid)
  archive = Number(ins.run(ACC, 'Archive', 'Archive', 'archive').lastInsertRowid)
})

function add(o: {
  folder?: number
  thread: string | null
  date: number
  seen?: boolean
  starred?: boolean
  from?: string
}): number {
  uid++
  const flags = [o.seen ? '\\Seen' : null, o.starred ? '\\Flagged' : null].filter(Boolean)
  return upsertMessage({
    account_id: ACC,
    folder_id: o.folder ?? inbox,
    uid,
    message_id: `<m${uid}@t>`,
    thread_id: o.thread,
    in_reply_to: null,
    from_addr: o.from ?? 'them@x.test',
    from_name: null,
    to_addrs: JSON.stringify([{ address: ME, name: null }]),
    cc_addrs: '[]',
    subject: `s${uid}`,
    date: o.date,
    snippet: null,
    flags: JSON.stringify(flags)
  })
}

interface Row {
  folder_id: number
  thread_key: string
  newest_id: number
  msg_count: number
  unread_count: number
  flagged: number
}

/** Computed in JS from the messages table, independent of the SQL rebuild. */
function oracle(): Row[] {
  const msgs = getDb()
    .prepare('SELECT id, folder_id, thread_id, date, flags FROM messages WHERE folder_id IS NOT NULL')
    .all() as { id: number; folder_id: number; thread_id: string | null; date: number | null; flags: string | null }[]
  const groups = new Map<string, typeof msgs>()
  for (const m of msgs) {
    const k = `${m.folder_id}|${m.thread_id ?? `#${m.id}`}`
    groups.set(k, [...(groups.get(k) ?? []), m])
  }
  const lower = (f: string | null) => (JSON.parse(f ?? '[]') as string[]).map((x) => x.toLowerCase())
  return [...groups.values()]
    .map((list) => {
      const newest = [...list].sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || b.id - a.id)[0]
      return {
        folder_id: list[0].folder_id,
        thread_key: list[0].thread_id ?? `#${list[0].id}`,
        newest_id: newest.id,
        msg_count: list.length,
        unread_count: list.filter((m) => !lower(m.flags).includes('\\seen')).length,
        flagged: list.some((m) => lower(m.flags).includes('\\flagged')) ? 1 : 0
      }
    })
    .sort((a, b) => a.folder_id - b.folder_id || a.thread_key.localeCompare(b.thread_key))
}

function model(): Row[] {
  refreshListRows()
  return (
    getDb()
      .prepare('SELECT folder_id, thread_key, newest_id, msg_count, unread_count, flagged FROM list_rows')
      .all() as Row[]
  ).sort((a, b) => a.folder_id - b.folder_id || a.thread_key.localeCompare(b.thread_key))
}

/** mulberry32: a seeded PRNG so a failing seed reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('list read model', () => {
  it.each([1, 2, 3, 42, 1234])(
    'matches a fresh GROUP BY after random upserts, flags, moves, deletes and rethreads (seed %i)',
    (seed) => {
      const r = rng(seed)
      const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)]
      const live: number[] = []
      const moved = new Map<number, { folder: number; uid: number }>()
      for (let step = 0; step < 300; step++) {
        const op = r()
        if (op < 0.4 || !live.length) {
          live.push(
            add({
              folder: pick([inbox, archive]),
              thread: pick(['t1', 't2', 't3', 't4', null]) ?? null,
              date: Math.floor(r() * 1000),
              seen: r() < 0.5,
              starred: r() < 0.2
            })
          )
        } else if (op < 0.6) {
          setFlags(pick(live)!, JSON.stringify(r() < 0.5 ? ['\\Seen'] : []))
        } else if (op < 0.75) {
          const id = pick(live)!
          const m = getDb().prepare('SELECT folder_id, uid FROM messages WHERE id = ?').get(id) as
            | { folder_id: number; uid: number | null }
            | undefined
          if (m?.uid) {
            moved.set(id, { folder: m.folder_id, uid: m.uid })
            moveMessage(id, m.folder_id === inbox ? archive : inbox)
          }
        } else if (op < 0.82) {
          const entry = pick([...moved.entries()])
          if (entry) {
            restoreMessage(entry[0], entry[1].folder, entry[1].uid)
            moved.delete(entry[0])
          }
        } else if (op < 0.9) {
          const i = Math.floor(r() * live.length)
          deleteMessageLocal(live[i])
          moved.delete(live[i])
          live.splice(i, 1)
        } else {
          getDb()
            .prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
            .run(pick(['t1', 't5', null]) ?? null, pick(live)!)
        }
        if (step % 7 === 0) expect(model()).toEqual(oracle())
      }
      expect(model()).toEqual(oracle())
    }
  )

  it('lists newest thread first with its counts, and counts conversations', () => {
    add({ thread: 'a', date: 100, seen: true })
    add({ thread: 'a', date: 300 })
    add({ thread: 'b', date: 200, seen: true })
    const rows = listView(inbox)
    expect(rows.map((x) => [x.subject, x.thread_count, x.thread_unread])).toEqual([
      ['s2', 2, 1],
      ['s3', 1, 0]
    ])
    expect(countView(inbox)).toBe(2)
  })

  it('knows when the last word in a thread is mine, across folders', () => {
    add({ thread: 'a', date: 100 })
    add({ folder: archive, thread: 'a', date: 200, from: 'ME@x.test' })
    refreshListRows()
    const row = getDb()
      .prepare('SELECT last_from_me FROM list_rows WHERE folder_id = ?')
      .get(inbox) as { last_from_me: number }
    expect(row.last_from_me).toBe(1)
  })

  it('does not let an unsent reply draft be the last word', () => {
    const drafts = Number(
      getDb()
        .prepare('INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)')
        .run(ACC, 'Drafts', 'Drafts', 'drafts').lastInsertRowid
    )
    add({ thread: 'a', date: 100 })
    add({ folder: drafts, thread: 'a', date: 200, from: ME })
    refreshListRows()
    const row = getDb()
      .prepare('SELECT last_from_me FROM list_rows WHERE folder_id = ?')
      .get(inbox) as { last_from_me: number }
    expect(row.last_from_me).toBe(0)
  })

  it('does not let a junk or trashed message bring back a reminded thread', () => {
    const ins = getDb().prepare('INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)')
    const junk = Number(ins.run(ACC, 'Junk', 'Junk', 'junk').lastInsertRowid)
    const trash = Number(ins.run(ACC, 'Trash', 'Trash', 'trash').lastInsertRowid)
    add({ thread: 'a', date: 100 })
    getDb()
      .prepare(
        'INSERT INTO reminders (account_id,message_id,remind_at,created_at) VALUES (?,?,?,?)'
      )
      .run(ACC, '<m1@t>', 10_000, 150)
    markDirtyByMessageId(ACC, '<m1@t>')
    expect(listView(inbox)).toHaveLength(0)

    add({ folder: junk, thread: 'a', date: 200 })
    add({ folder: trash, thread: 'a', date: 300 })
    expect(listView(inbox)).toHaveLength(0)

    add({ thread: 'a', date: 400 })
    expect(listView(inbox)).toHaveLength(1)
  })

  it('rebuilds many threadless messages by rowid, not by scanning list_dirty per message', () => {
    const db = getDb()
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        add({ folder: i % 2 ? inbox : archive, thread: i % 3 ? `t${i % 200}` : null, date: i, seen: i % 5 === 0 })
      }
    })()
    // Each '#<id>' key must drive a rowid lookup of its message. The quadratic
    // plan made messages the outer loop and range-scanned list_dirty per row.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${REBUILD_SQL}`).all() as { detail: string }[]).map(
      (r) => r.detail
    )
    // The '#<id>' arm is the second UNION ALL arm, so its SCAN d comes last.
    const scanD = plan.lastIndexOf('SCAN d')
    expect(scanD).toBeGreaterThan(-1)
    expect(plan[scanD + 1]).toBe('SEARCH m USING INTEGER PRIMARY KEY (rowid=?)')
    expect(plan.some((d) => d.includes('thread_key>? AND thread_key<?'))).toBe(false)
    // Threaded keys likewise: one index search per dirty thread, never a scan
    // of every message in the account.
    expect(plan).toContain('SEARCH m USING INDEX idx_messages_account_thread (account_id=? AND thread_id=?)')
    expect(plan.some((d) => d.startsWith('SCAN m'))).toBe(false)

    expect(model()).toEqual(oracle())
    db.prepare('UPDATE list_rows SET unread_count = unread_count + 1').run()
    expect(repairListDrift(ACC).sort()).toEqual([inbox, archive].sort())
    expect(model()).toEqual(oracle())
  })

  it('repairs a folder whose counts drifted', () => {
    add({ thread: 'a', date: 100 })
    refreshListRows()
    getDb().prepare('UPDATE list_rows SET unread_count = 99').run()
    expect(repairListDrift(ACC)).toEqual([inbox])
    expect(listView(inbox)[0].thread_unread).toBe(1)
    expect(repairListDrift(ACC)).toEqual([])
  })
})
