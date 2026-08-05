import { contextBridge, ipcRenderer } from 'electron'
import type { Folder, Message, MessageListRow } from '../src/core/store/types.js'
import type { SyncProgress } from '../src/core/sync/syncEngine.js'

export interface ScheduledSend {
  id: number
  to_addrs: string
  subject: string | null
  send_at: number
  status: string
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

export interface BootStatus {
  ok: boolean
  email?: string
  error?: string
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
}

export interface QueueSendPayload extends DraftPayload {
  draftId: number
  sendAt: number
  attachments?: ComposeAttachment[]
}

const api = {
  bootStatus: (): Promise<BootStatus> => ipcRenderer.invoke('boot:status'),
  listFolders: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list'),
  listMessages: (folderId: number, limit?: number, offset?: number): Promise<MessageListRow[]> =>
    ipcRenderer.invoke('messages:list', folderId, limit, offset),
  searchContacts: (
    query: string,
    limit?: number
  ): Promise<{ address: string; name: string | null }[]> =>
    ipcRenderer.invoke('contacts:search', query, limit),
  countMessages: (folderId: number): Promise<number> =>
    ipcRenderer.invoke('messages:count', folderId),
  listDrafts: (limit?: number, offset?: number): Promise<MessageListRow[]> =>
    ipcRenderer.invoke('messages:listDrafts', limit, offset),
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
  getThread: (threadId: string): Promise<Message[]> =>
    ipcRenderer.invoke('thread:get', threadId),
  markThreadRead: (
    threadId: string
  ): Promise<{ ok: true; changed: number[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('thread:markRead', threadId),
  getBody: (messageId: number, allowRemoteImages?: boolean): Promise<BodyResult> =>
    ipcRenderer.invoke('message:body', messageId, allowRemoteImages),
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
  // Trash. The IMAP MOVE is deferred for the undo window, so the returned
  // batchId is what undoMove reverses.
  moveMessages: (
    ids: number[]
  ): Promise<
    | { ok: true; batchId: number; moved: number[]; toPath: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('messages:move', ids),
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
  onNewMail: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('mail:new', h)
    return () => ipcRenderer.off('mail:new', h)
  },
  onSyncProgress: (cb: (p: SyncProgress) => void): (() => void) => {
    const h = (_e: unknown, p: SyncProgress): void => cb(p)
    ipcRenderer.on('sync:progress', h)
    return () => ipcRenderer.off('sync:progress', h)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
