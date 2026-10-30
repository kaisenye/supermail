import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fakeAi } from '../services/ai/fake.js'
import { closeDb, getDb, initDb } from '../store/db.js'
import { upsertMessage } from '../store/repo.js'
import { askMail, askTerms, hanGrams, retrieveForAsk, shortHan } from './ask.js'

let uid = 0
function add(account: number, thread: string, subject: string, body: string, date: number, from = 'Acme <acme@billing.test>') {
  uid++
  const [, name, addr] = /^(.*) <(.*)>$/.exec(from)!
  upsertMessage({
    account_id: account,
    folder_id: account,
    uid,
    message_id: `<k${uid}@t>`,
    thread_id: thread,
    in_reply_to: null,
    from_addr: addr,
    from_name: name,
    to_addrs: '[]',
    cc_addrs: '[]',
    subject,
    date,
    snippet: body.slice(0, 40),
    body_text: body,
    body_fetched: 1,
    flags: '[]'
  })
}

beforeEach(() => {
  closeDb()
  initDb(join(mkdtempSync(join(tmpdir(), 'ask-')), 't.db'))
  uid = 0
  const db = getDb()
  db.prepare("INSERT INTO accounts (id,email) VALUES (1,'a@x.test'),(2,'b@x.test')").run()
  db.prepare("INSERT INTO folders (id,account_id,path,role) VALUES (1,1,'INBOX','inbox'),(2,2,'INBOX','inbox')").run()
  add(1, 'inv', 'Invoice 42', 'Your Acme invoice for October is $120, due Nov 5.', 1000)
  add(1, 'inv', 'Re: Invoice 42', 'Reminder: the Acme invoice is due soon.', 2000)
  add(2, 'trip', 'Flight to Lisbon', 'Your flight leaves at 9am.', 3000, 'Fly <tickets@fly.test>')
})

describe('Ask AI', () => {
  it('keeps the content words of a question', () => {
    expect(askTerms('When is the Acme invoice due?')).toEqual(['acme', 'invoice', 'due'])
    expect(askTerms('what did they say?')).toEqual(['they'])
  })

  it('finds one hit per conversation across accounts', () => {
    const hits = retrieveForAsk([1, 2], 'Acme invoice')
    expect(hits.map((h) => [h.n, h.account_id, h.thread_id])).toEqual([[1, 1, 'inv']])
    expect(retrieveForAsk([2], 'flight Lisbon').map((h) => h.subject)).toEqual(['Flight to Lisbon'])
    expect(retrieveForAsk([1], 'flight')).toEqual([])
  })

  it('answers from numbered sources and returns them without their text', async () => {
    const ai = fakeAi(() => 'It is due Nov 5 [1].')
    const r = await askMail(ai, [1, 2], 'When is the Acme invoice due?', new Date(2026, 9, 30).getTime())
    expect(r.answer).toBe('It is due Nov 5 [1].')
    expect(r.sources).toHaveLength(1)
    expect(r.sources[0]).not.toHaveProperty('text')
    expect(ai.calls[0].feature).toBe('ask')
    expect(ai.calls[0].req.prompt).toContain('Today is 2026-10-30')
    expect(ai.calls[0].req.prompt).toContain('<message n="1"')
    expect(ai.calls[0].req.prompt).toContain('Question: When is the Acme invoice due?')
  })

  it('finds Chinese mail for a Chinese question through the trigram index', async () => {
    add(2, 'fp', '十月账单', '请确认本月发票金额和付款时间，谢谢。', 4000, 'Tencent <bill@qq.test>')
    add(1, 'other', '会议纪要', '下周一上午十点开会。', 5000, 'Team <team@qq.test>')
    // unicode61 keeps the whole run as one token, so plain FTS cannot match inside it.
    // Function words cut the run, so the question words fall away.
    expect(askTerms('发票金额是多少？')).toEqual(['发票金额'])
    expect(hanGrams(['发票金额是多少', 'acme'])).toEqual(['发票金', '票金额', '金额是', '额是多', '是多少'])
    const hits = retrieveForAsk([1, 2], '发票金额是多少？')
    expect(hits.map((h) => [h.n, h.account_id, h.thread_id])).toEqual([[1, 2, 'fp']])
    expect(hits[0].text).toContain('发票金额')
    expect(retrieveForAsk([1], '发票金额是多少？')).toEqual([])
    const ai = fakeAi(() => '见 [1]。')
    const r = await askMail(ai, [1, 2], '发票金额是多少？')
    expect(r.sources.map((s) => s.thread_id)).toEqual(['fp'])
    expect(ai.calls).toHaveLength(1)
  })

  it('cuts Chinese function words out of a Han run', () => {
    expect(askTerms('上个月的发票')).toEqual(['上个月', '发票'])
    expect(askTerms('发票 付款')).toEqual(['发票', '付款'])
    expect(askTerms('付款时间是什么？')).toEqual(['付款时间'])
    expect(shortHan(['发票', '上个月', 'acme', '付款'])).toEqual(['发票', '付款'])
  })

  it('drops the single characters a cut leaves behind', async () => {
    expect(askTerms('我们的发票')).toEqual(['发票'])
    expect(askTerms('现在付款了吗')).toEqual(['付款'])
    expect(askTerms('你们在哪')).toEqual([])
    // A one-character question is still searched as typed.
    expect(askTerms('钱')).toEqual(['钱'])

    add(2, 'fp', '十月账单', '请确认本月发票金额', 1000, 'Tencent <bill@qq.test>')
    for (let i = 0; i < 50; i++) add(1, `n${i}`, '通知', `我们下周开会 ${i}`, 5000 + i, 'Team <team@qq.test>')
    expect(retrieveForAsk([1, 2], '我们的发票').map((h) => h.thread_id)).toEqual(['fp'])
  })

  it('finds Chinese mail for short keywords too short for a trigram window', async () => {
    add(2, 'fp', '十月账单', '请确认本月发票金额和付款时间', 4000, 'Tencent <bill@qq.test>')
    add(1, 'other', '会议纪要', '下周一上午十点开会。', 5000, 'Team <team@qq.test>')
    for (const q of ['发票', '发票 付款', '上个月的发票']) {
      const hits = retrieveForAsk([1, 2], q)
      expect(hits.map((h) => [h.account_id, h.thread_id]), q).toEqual([[2, 'fp']])
      expect(retrieveForAsk([1], q), q).toEqual([])
    }
    // Subject matches as well as body.
    expect(retrieveForAsk([1, 2], '账单').map((h) => h.thread_id)).toEqual(['fp'])
    const ai = fakeAi(() => '见 [1]。')
    const r = await askMail(ai, [1, 2], '上个月的发票')
    expect(r.sources.map((s) => s.thread_id)).toEqual(['fp'])
    expect(ai.calls).toHaveLength(1)
  })

  it('leaves drafts out of short-keyword hits', () => {
    add(1, 'd', '草稿', '发票草稿', 4000)
    getDb().prepare("UPDATE messages SET folder_id = NULL WHERE thread_id = 'd'").run()
    expect(retrieveForAsk([1], '发票')).toEqual([])
  })

  it('keeps one hit per conversation when FTS and trigram both match', () => {
    add(1, 'mix', 'Acme 发票金额', 'Acme 发票金额 is attached.', 4000)
    const hits = retrieveForAsk([1], 'Acme 发票金额')
    expect(hits.map((h) => h.thread_id).sort()).toEqual(['inv', 'mix'])
  })

  it('leaves drafts out of trigram hits', () => {
    add(1, 'd', '发票金额', '发票金额草稿', 4000)
    getDb().prepare("UPDATE messages SET folder_id = NULL WHERE thread_id = 'd'").run()
    expect(retrieveForAsk([1], '发票金额')).toEqual([])
  })

  it('says so without calling the model when nothing matches', async () => {
    const ai = fakeAi(() => 'x')
    const r = await askMail(ai, [1, 2], 'kangaroo', Date.now())
    expect(r.sources).toEqual([])
    expect(ai.calls).toHaveLength(0)
  })
})
