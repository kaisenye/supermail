import { contextBridge, ipcRenderer } from 'electron'
import type { Folder, Message, MessageListRow } from '../src/core/store/types.js'
import type { MoveTarget } from '../src/core/store/folderRoles.js'
import type { SyncProgress } from '../src/core/sync/syncEngine.js'
import type { MailProvider } from '../src/core/accounts/auth.js'
import type { ReminderSnapshot } from '../src/core/triage/reminders.js'
import type { ContactProfile } from '../src/core/store/contacts.js'
import type { AiStatus } from '../src/core/services/ai/service.js'
import type { AiConfigInput } from '../src/core/services/ai/settings.js'
import type { AiErrorCode, AiFeature, AiProviderId } from '../src/core/services/ai/types.js'
import type { WriteAction } from '../src/core/ai/write.js'
import type { ThreadInsights } from '../src/core/ai/insights.js'
import type { AskSource } from '../src/core/ai/ask.js'
import type { AiLabel } from '../src/core/store/aiLabels.js'

export interface ScheduledSend {
  id: number
  to_addrs: string
  subject: string | null
  send_at: number
  status: string
  /** The account the send leaves from. */
  from_addr: string | null
}

export interface ComposeAttachment {
  path: string
  filename: string
  contentType: string
  size: number
}

export interface Attachment {
  id: number
  filename: string | null
  mime: string | null
  size: number | null
}

export type BodyResult =
  | {
      ok: true
      id: number
      html: string
      blockedImages: number
      isHtml: boolean
      attachments: Attachment[]
    }
  | { ok: false; error: string }

export type AttachmentData =
  | { ok: true; base64: string; mime: string; filename: string }
  | { ok: false; error: string }

export interface AccountSummary {
  accountId: number
  email: string
  name: string | null
  provider: MailProvider
  active: boolean
  needsReauth: boolean
}

export interface BootStatus {
  ok: boolean
  email?: string
  error?: string
  accounts: AccountSummary[]
  activeAccountId: number | null
}

export interface ProviderPreset {
  id: string
  label: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSavesSent: boolean
  passwordHint?: string
}

export interface NewAccountInput {
  email: string
  pass: string
  name: string | null
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSavesSent?: boolean
}

export type SyncRunResult =
  | {
      ok: true
      folders: number
      messages: number
      errors: { folder: string; message: string }[]
      skipped?: boolean
    }
  | { ok: false; error: string }

export interface DraftPayload {
  draftId: number | null
  to: string
  cc?: string
  bcc?: string
  subject?: string
  body?: string
  inReplyTo?: string | null
  references?: string | null
  attachments?: ComposeAttachment[]
  /** The account it sends from (a reply to another account's mail); null = the active one. */
  accountId?: number | null
}

export interface QueueSendPayload extends DraftPayload {
  draftId: number
  /** null = now, after the undo window (main decides its length). */
  sendAt: number | null
  attachments?: ComposeAttachment[]
  /** "Remind me if no reply": main saves the reminder once the mail is sent. */
  remindAt?: number | null
  /** Scheduled send only: cancel it if someone replies first. */
  cancelOnReply?: boolean
}

/** An inbox split: a named list-context query (src/core/store/splits.ts). */
export interface Split {
  id: string
  name: string
  query: string
  builtin: boolean
}

/** A compose snippet: plain text with {variables} (src/core/store/snippets.ts). */
export interface Snippet {
  id: number
  name: string
  shortcut: string | null
  body: string
  created_at: number
  updated_at: number
}

export type Priority = 0 | 1 | 2 | 3 | 4

export interface Task {
  id: number
  account_id: number
  title: string
  description: string | null
  due_at: number | null
  done_at: number | null
  priority: Priority
  created_at: number
  updated_at: number
  sort_order: number
}

export interface TaskQuery {
  includeDone?: boolean
  search?: string
  sort?: 'manual' | 'due' | 'priority'
  minPriority?: number
  dueBefore?: number
}

type TaskResult = { ok: true; task: Task } | { ok: false; error: string }

export type { AiConfigInput, AiFeature, AiLabel, AiProviderId, AiStatus, AskSource, WriteAction }

/** Every AI call fails the same way; `code` tells the UI whether to point at Settings. */
export type AiFailure = { ok: false; code: AiErrorCode; error: string }
type AiStatusResult = { ok: true; status: AiStatus } | AiFailure
/** What the thread view shows, plus which features are on. */
export type AiInsights = ThreadInsights & { features: Record<AiFeature, boolean> }

const api = {
  listTasks: (query?: TaskQuery): Promise<Task[]> => ipcRenderer.invoke('tasks:list', query),
  createTask: (input: {
    title: string
    description?: string | null
    due_at?: number | null
    priority?: Priority
  }): Promise<TaskResult> => ipcRenderer.invoke('tasks:create', input),
  updateTask: (
    id: number,
    patch: {
      title?: string
      description?: string | null
      due_at?: number | null
      priority?: Priority
    }
  ): Promise<TaskResult> => ipcRenderer.invoke('tasks:update', id, patch),
  setTaskDone: (id: number, done: boolean): Promise<TaskResult> =>
    ipcRenderer.invoke('tasks:setDone', id, done),
  deleteTask: (id: number): Promise<{ ok: true }> => ipcRenderer.invoke('tasks:delete', id),
  countOpenTasks: (): Promise<number> => ipcRenderer.invoke('tasks:countOpen'),
  bootStatus: (): Promise<BootStatus> => ipcRenderer.invoke('boot:status'),
  /** Fires once after the one-time threading repair merges split conversations. */
  onThreadingRepaired: (fn: (p: { updated: number }) => void): (() => void) => {
    const h = (_e: unknown, p: { updated: number }): void => fn(p)
    ipcRenderer.on('threading:repaired', h)
    return () => ipcRenderer.removeListener('threading:repaired', h)
  },
  accountPresets: (): Promise<ProviderPreset[]> => ipcRenderer.invoke('account:presets'),
  accountPreset: (email: string): Promise<ProviderPreset> =>
    ipcRenderer.invoke('account:preset', email),
  accountTest: (
    input: NewAccountInput
  ): Promise<{ ok: boolean; stage?: string; message?: string; mailboxes?: number }> =>
    ipcRenderer.invoke('account:test', input),
  accountAdd: (
    input: NewAccountInput
  ): Promise<{ ok: boolean; accountId?: number; email?: string; error?: string }> =>
    ipcRenderer.invoke('account:add', input),
  accountOAuth: (
    provider: 'google' | 'microsoft',
    expectedEmail?: string
  ): Promise<{ ok: true; accountId: number; email: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('account:oauth', provider, expectedEmail),
  onReauthNeeded: (fn: (email: string) => void): (() => void) => {
    const h = (_e: unknown, email: string) => fn(email)
    ipcRenderer.on('account:reauth', h)
    return () => ipcRenderer.removeListener('account:reauth', h)
  },
  accountSetActive: (accountId: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('account:setActive', accountId),
  accountRemove: (accountId: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('account:remove', accountId),
  listFolders: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list'),
  listMessages: (
    folderId: number,
    limit?: number,
    offset?: number,
    query?: string
  ): Promise<MessageListRow[]> => ipcRenderer.invoke('messages:list', folderId, limit, offset, query),
  searchContacts: (
    query: string,
    limit?: number
  ): Promise<{ address: string; name: string | null }[]> =>
    ipcRenderer.invoke('contacts:search', query, limit),
  countMessages: (folderId: number, query?: string): Promise<number> =>
    ipcRenderer.invoke('messages:count', folderId, query),
  listDrafts: (limit?: number, offset?: number): Promise<MessageListRow[]> =>
    ipcRenderer.invoke('messages:listDrafts', limit, offset),
  listSnippets: (): Promise<Snippet[]> => ipcRenderer.invoke('snippets:list'),
  saveSnippet: (input: {
    id?: number
    name: string
    shortcut?: string | null
    body: string
  }): Promise<{ ok: true; snippet: Snippet } | { ok: false; error: string }> =>
    ipcRenderer.invoke('snippets:save', input),
  deleteSnippet: (id: number): Promise<{ ok: true }> => ipcRenderer.invoke('snippets:delete', id),
  searchServer: (query: string): Promise<{ ok: true; stored: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('search:server', query),
  searchAll: (query: string, limit?: number): Promise<MessageListRow[]> => ipcRenderer.invoke('search:all', query, limit),
  searchTasks: (query: string, limit?: number): Promise<Task[]> => ipcRenderer.invoke('tasks:search', query, limit),
  contactForThread: (threadId: string, accountId?: number): Promise<ContactProfile | null> =>
    ipcRenderer.invoke('contact:forThread', threadId, accountId),
  listSplits: (): Promise<Split[]> => ipcRenderer.invoke('splits:list'),
  saveSplit: (input: {
    id?: string
    name: string
    query: string
  }): Promise<{ ok: true; split: Split } | { ok: false; error: string }> =>
    ipcRenderer.invoke('splits:save', input),
  deleteSplit: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('splits:delete', id),
  splitCounts: (folderId: number, extraQuery?: string): Promise<Record<string, number>> =>
    ipcRenderer.invoke('splits:counts', folderId, extraQuery),
  archiveStatus: (): Promise<
    | { ok: true; hasArchive: boolean; canCreate: boolean; reason?: string; host: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('triage:archiveStatus'),
  createArchive: (): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('triage:createArchive'),
  setReminder: (
    ids: number[],
    remindAt: number,
    ifNoReply: boolean
  ): Promise<{
    ok: true
    /** Row ids that got a reminder (rows without a Message-ID are skipped). */
    set: number[]
    /** Row ids that had no reminder before: undo clears these. */
    fresh: number[]
    /** The reminders that were rescheduled, as they were: undo restores these. */
    prev: ReminderSnapshot[]
    holdMs: number
  }> => ipcRenderer.invoke('reminders:set', ids, remindAt, ifNoReply),
  restoreReminders: (rows: ReminderSnapshot[]): Promise<{ ok: true }> =>
    ipcRenderer.invoke('reminders:restore', rows),
  /** Returns what it cleared and the undo window, so Done in Reminders can be undone. */
  clearReminders: (
    ids: number[]
  ): Promise<{ ok: true; cleared: ReminderSnapshot[]; holdMs: number }> =>
    ipcRenderer.invoke('reminders:clear', ids),
  listReminders: (): Promise<MessageListRow[]> => ipcRenderer.invoke('reminders:list'),
  toggleMute: (
    ids: number[],
    set?: boolean
  ): Promise<
    | { ok: true; muted: boolean; changed: number[]; holdMs: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('triage:mute', ids, set),
  toggleVip: (
    ids: number[],
    set?: boolean
  ): Promise<
    | { ok: true; vip: boolean; changed: number[]; holdMs: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('triage:vip', ids, set),
  /** Labels every account owning these rows shares (empty when any is not Gmail). */
  labelChoices: (ids: number[]): Promise<string[]> => ipcRenderer.invoke('labels:choices', ids),
  labelsFor: (ids: number[]): Promise<Record<number, string[]>> =>
    ipcRenderer.invoke('labels:forMessages', ids),
  setLabel: (
    ids: number[],
    label: string,
    add: boolean
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('messages:label', ids, label, add),
  unsubscribePlan: (
    rowId: number
  ): Promise<{ ok: true; sender: string; description: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('unsubscribe:plan', rowId),
  unsubscribe: (rowId: number): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('unsubscribe:run', rowId),
  zeroCount: (
    folderId: number,
    opts: { olderThanDays: number; keepUnread: boolean; keepStarred: boolean }
  ): Promise<{ ok: true; count: number }> => ipcRenderer.invoke('triage:zero', folderId, opts, true),
  zero: (
    folderId: number,
    opts: { olderThanDays: number; keepUnread: boolean; keepStarred: boolean }
  ): Promise<
    { ok: true; batchId: number; moved: number[]; holdMs: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('triage:zero', folderId, opts, false),
  deleteDraft: (id: number): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('draft:delete', id),
  loadOlder: (
    folderId: number,
    limit?: number
  ): Promise<
    { ok: true; messages: number; more: boolean } | { ok: false; error: string }
  > => ipcRenderer.invoke('messages:loadOlder', folderId, limit),
  search: (query: string, limit?: number): Promise<MessageListRow[]> =>
    ipcRenderer.invoke('messages:search', query, limit),
  getThread: (threadId: string, accountId?: number): Promise<Message[]> =>
    ipcRenderer.invoke('thread:get', threadId, accountId),
  markThreadRead: (
    threadId: string,
    accountId?: number
  ): Promise<{ ok: true; changed: number[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('thread:markRead', threadId, accountId),
  markThreadsUnread: (
    threadIds: string[],
    accountId?: number
  ): Promise<{ ok: true; changed: number[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('thread:markUnread', threadIds, accountId),
  getBody: (messageId: number, allowRemoteImages?: boolean): Promise<BodyResult> =>
    ipcRenderer.invoke('message:body', messageId, allowRemoteImages),
  prefetchBodies: (ids: number[]): Promise<void> =>
    ipcRenderer.invoke('messages:prefetchBodies', ids),
  getMessage: (id: number): Promise<Message | undefined> =>
    ipcRenderer.invoke('message:get', id),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open', url),
  attachmentData: (id: number): Promise<AttachmentData> =>
    ipcRenderer.invoke('attachment:data', id),
  saveAttachment: (
    id: number
  ): Promise<{ ok: true; path: string | null } | { ok: false; error: string }> =>
    ipcRenderer.invoke('attachment:save', id),
  openAttachment: (id: number): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('attachment:open', id),
  toggleFlag: (
    id: number,
    flag: string
  ): Promise<{ ok: true; flags: string[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('message:toggleFlag', id, flag),
  // Bulk flags (read/unread/star) — requires main restart after changes.
  setFlag: (
    ids: number[],
    flag: string,
    add: boolean
  ): Promise<
    | { ok: true; updated: { id: number; flags: string[] }[] }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('messages:setFlag', ids, flag, add),
  // The IMAP MOVE is deferred for the undo window, so the returned batchId is
  // what undoMove reverses.
  moveMessages: (
    ids: number[],
    target: MoveTarget
  ): Promise<
    { ok: true; batchId: number; moved: number[]; holdMs: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('messages:move', ids, target),
  undoMove: (
    batchId: number
  ): Promise<{ ok: true; restored: number[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('messages:undoMove', batchId),
  unreadCounts: (): Promise<Record<number, number>> =>
    ipcRenderer.invoke('folders:unread'),
  getSettings: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:get'),
  pickSignatureLogo: (): Promise<
    { ok: true; path: string; dataUrl: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('settings:pickLogo'),
  setSettings: (patch: Record<string, string>): Promise<{ ok: true }> =>
    ipcRenderer.invoke('settings:set', patch),
  aiLabels: (accountId: number): Promise<AiLabel[]> => ipcRenderer.invoke('ai:labels', accountId),
  /** The sidebar's "your labels": the mail server's (Gmail) labels, then the inbox's own. */
  aiSidebarLabels: (accountId: number): Promise<{ provider: string[]; own: string[] }> =>
    ipcRenderer.invoke('ai:sidebarLabels', accountId),
  aiSaveLabel: (input: {
    id?: number
    accountId: number
    name: string
    description: string
  }): Promise<{ ok: true; label: AiLabel } | { ok: false; error: string }> => ipcRenderer.invoke('ai:saveLabel', input),
  aiDeleteLabel: (id: number): Promise<{ ok: true; label: AiLabel | null }> => ipcRenderer.invoke('ai:deleteLabel', id),
  aiStatus: (): Promise<AiStatus> => ipcRenderer.invoke('ai:status'),
  /** Write-only: the key goes to the vault in main and is never sent back. */
  aiSetKey: (provider: AiProviderId, key: string): Promise<AiStatusResult> =>
    ipcRenderer.invoke('ai:setKey', provider, key),
  aiClearKey: (provider: AiProviderId): Promise<AiStatusResult> => ipcRenderer.invoke('ai:clearKey', provider),
  aiSetConfig: (input: AiConfigInput): Promise<AiStatusResult> => ipcRenderer.invoke('ai:setConfig', input),
  /** Draft or rewrite compose text. Main reads the replied-to thread itself from `sourceMessageId`. */
  aiWrite: (input: {
    action: WriteAction
    text: string
    instruction?: string
    scope?: 'selection' | 'message'
    sourceMessageId?: number | null
  }): Promise<{ ok: true; text: string } | AiFailure> => ipcRenderer.invoke('ai:write', input),
  aiInsights: (threadId: string, accountId?: number): Promise<AiInsights> =>
    ipcRenderer.invoke('ai:insights', threadId, accountId),
  aiSummarize: (threadId: string, accountId?: number): Promise<{ ok: true; summary: string | null } | AiFailure> =>
    ipcRenderer.invoke('ai:summarize', threadId, accountId),
  /** Instant Reply on demand: null when the conversation has nothing to answer. */
  aiSuggestReplies: (
    threadId: string,
    accountId?: number
  ): Promise<{ ok: true; replies: { messageRowId: number; options: string[] } | null } | AiFailure> =>
    ipcRenderer.invoke('ai:suggestReplies', threadId, accountId),
  /** Ask AI over the local mail of every account; sources are what the answer cites as [n]. */
  aiAsk: (question: string): Promise<{ ok: true; answer: string; sources: AskSource[] } | AiFailure> =>
    ipcRenderer.invoke('ai:ask', question),
  /** The background worker stored new verdicts or reply suggestions. */
  onAiUpdated: (cb: (p: { kinds: ('classify' | 'replies' | 'labels')[] }) => void): (() => void) => {
    const h = (_e: unknown, p: { kinds: ('classify' | 'replies' | 'labels')[] }): void => cb(p)
    ipcRenderer.on('ai:updated', h)
    return () => ipcRenderer.off('ai:updated', h)
  },
  saveDraft: (
    payload: DraftPayload
  ): Promise<{ ok: true; draftId: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('compose:saveDraft', payload),
  queueSend: (
    payload: QueueSendPayload
  ): Promise<{ ok: true; outboxId: number; sendAt: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('compose:queueSend', payload),
  cancelSend: (
    outboxId: number
  ): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke('compose:cancelSend', outboxId),
  pickAttachments: (): Promise<ComposeAttachment[]> =>
    ipcRenderer.invoke('compose:pickAttachments'),
  listScheduled: (): Promise<ScheduledSend[]> => ipcRenderer.invoke('compose:listScheduled'),
  runSync: (): Promise<SyncRunResult> => ipcRenderer.invoke('sync:run'),
  /** Syncs one account by email, active or not (an IDLE push from it). */
  runSyncAccount: (email: string): Promise<SyncRunResult> => ipcRenderer.invoke('sync:runAccount', email),
  runBodySync: (): Promise<{ ok: boolean; fetched?: number; error?: string }> =>
    ipcRenderer.invoke('bodySync:run'),
  onBodySyncProgress: (
    cb: (p: { fetched: number; total: number; folder: string; done: boolean }) => void
  ): (() => void) => {
    const h = (_e: unknown, p: { fetched: number; total: number; folder: string; done: boolean }): void =>
      cb(p)
    ipcRenderer.on('bodySync:progress', h)
    return () => ipcRenderer.off('bodySync:progress', h)
  },
  onSendFailed: (
    cb: (f: { outboxId: number; subject: string | null; to: string; error: string }) => void
  ): (() => void) => {
    const h = (
      _e: unknown,
      f: { outboxId: number; subject: string | null; to: string; error: string }
    ): void => cb(f)
    ipcRenderer.on('send:failed', h)
    return () => ipcRenderer.off('send:failed', h)
  },
  onSendCancelledOnReply: (
    cb: (c: { outboxId: number; accountId: number; subject: string | null; to: string }[]) => void
  ): (() => void) => {
    const h = (_e: unknown, c: { outboxId: number; accountId: number; subject: string | null; to: string }[]): void => cb(c)
    ipcRenderer.on('send:cancelledOnReply', h)
    return () => ipcRenderer.off('send:cancelledOnReply', h)
  },
  /**
   * Reminders came due. Threads with an Inbox row are back at its top; one
   * that lives only elsewhere (a new mail in Sent) shows in g h and the
   * notification only.
   */
  onRemindersFired: (cb: (p: { count: number }) => void): (() => void) => {
    const h = (_e: unknown, p: { count: number }): void => cb(p)
    ipcRenderer.on('reminders:fired', h)
    return () => ipcRenderer.off('reminders:fired', h)
  },
  /** IDLE push: new mail for the account with this email. */
  /** A follow-up sync main ran on its own stored new mail for this account. */
  onSyncStored: (cb: (email: string) => void): (() => void) => {
    const h = (_e: unknown, email: string): void => cb(email)
    ipcRenderer.on('sync:stored', h)
    return () => ipcRenderer.off('sync:stored', h)
  },
  /** The network came back: main reconnects IDLE and the pool, then syncs. */
  networkOnline: (): void => ipcRenderer.send('net:online'),
  onNewMail: (cb: (email: string | undefined) => void): (() => void) => {
    const h = (_e: unknown, email?: string): void => cb(email)
    ipcRenderer.on('mail:new', h)
    return () => ipcRenderer.off('mail:new', h)
  },
  /** A just-sent message landed in the local Sent folder. */
  onSentStored: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('mail:sent-stored', h)
    return () => ipcRenderer.off('mail:sent-stored', h)
  },
  onSyncProgress: (cb: (p: SyncProgress) => void): (() => void) => {
    const h = (_e: unknown, p: SyncProgress): void => cb(p)
    ipcRenderer.on('sync:progress', h)
    return () => ipcRenderer.off('sync:progress', h)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
