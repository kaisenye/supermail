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
}

export interface QueueSendPayload extends DraftPayload {
  draftId: number
  sendAt: number
}

const api = {
  bootStatus: (): Promise<BootStatus> => ipcRenderer.invoke('boot:status'),
  listFolders: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list'),
  listMessages: (folderId: number, limit?: number, offset?: number): Promise<MessageListRow[]> =>
    ipcRenderer.invoke('messages:list', folderId, limit, offset),
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
  // Archive / trash via IMAP MOVE.
  moveMessages: (
    ids: number[],
    kind: 'archive' | 'trash'
  ): Promise<
    | { ok: true; moved: number[]; toPath: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('messages:move', ids, kind),
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
  onSyncProgress: (cb: (p: SyncProgress) => void): (() => void) => {
    const h = (_e: unknown, p: SyncProgress): void => cb(p)
    ipcRenderer.on('sync:progress', h)
    return () => ipcRenderer.off('sync:progress', h)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
