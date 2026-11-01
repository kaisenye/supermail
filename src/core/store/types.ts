import type { FolderRole } from './folderRoles.js'

export interface Account {
  id: number
  email: string
  imap_host: string | null
  imap_port: number | null
  smtp_host: string | null
  smtp_port: number | null
  auth_ref: string | null
  provider: 'imap' | 'gmail' | 'microsoft'
  auth_type: 'password' | 'oauth2'
}

export interface Folder {
  id: number
  account_id: number
  name: string | null
  path: string
  uidvalidity: number | null
  last_uid: number
  /** Null for ordinary user folders. Set on every sync. */
  role: FolderRole | null
  /** 1 once full-history backfill has reached uid 1 (migration v20). */
  history_complete?: number
}

export interface Message {
  id: number
  account_id: number
  folder_id: number | null
  uid: number | null
  message_id: string | null
  thread_id: string | null
  in_reply_to: string | null
  from_addr: string | null
  from_name: string | null
  to_addrs: string | null
  cc_addrs: string | null
  bcc_addrs: string | null
  subject: string | null
  date: number | null
  snippet: string | null
  body_text: string | null
  body_html: string | null
  // Drafts only: kept so reopening one does not lose its thread or files.
  references_header: string | null
  draft_attachments: string | null
  flags: string | null
  has_attachments: number
  body_fetched: number
  summary: string | null
  ai_labels: string | null
  embedding_id: number | null
  entities: string | null
  workflow_state: string | null
  list_unsubscribe: string | null
  unsubscribe_one_click: number
  bulk: number
}

/** Envelope-only shape for list views — omits bodies so rows stay cheap. */
export type MessageListRow = Pick<
  Message,
  | 'id'
  | 'account_id'
  | 'thread_id'
  | 'from_addr'
  | 'from_name'
  | 'to_addrs'
  | 'subject'
  | 'date'
  | 'snippet'
  | 'flags'
  | 'has_attachments'
> & {
  /**
   * Thread rollup, present only where the list is threaded. The row itself is
   * still the newest message, so every other field reads as before.
   */
  thread_count?: number
  thread_unread?: number
  /** 1 when a reminder on this thread has fired (list_rows.reminder_fired). */
  reminder_fired?: number
  /**
   * What the list is ordered by (list_rows.sort_date): the newest message's
   * date, or a fired reminder's time when later. Date headers group on this.
   */
  sort_date?: number | null
  /** Set only in the Reminders view: when the reminder is due. */
  remind_at?: number
  /** The inbox's own AI labels on any message of the thread, comma-joined (v22); null for none. */
  ai_labels?: string | null
  /** The classifier's verdict on the thread (list_rows, v21): 1 important, 0 not, null unsorted. */
  ai_important?: number | null
  /** The classifier's category (AI_CATEGORIES), null when unsorted. */
  ai_category?: string | null
  /** Gmail user labels on any message of the thread, comma-joined; null for none. */
  server_labels?: string | null
}

export interface UpsertMessageInput {
  account_id: number
  folder_id: number | null
  uid: number | null
  message_id: string | null
  thread_id: string | null
  in_reply_to: string | null
  /**
   * The References header ids. Not stored: upsertMessage reads them to join
   * the thread of any stored message this one mentions.
   */
  references?: string[] | null
  from_addr: string | null
  from_name: string | null
  to_addrs: string | null
  cc_addrs: string | null
  subject: string | null
  date: number | null
  snippet: string | null
  body_text?: string | null
  body_html?: string | null
  /**
   * IMAP flags as a JSON array. `undefined` means "this pass has no authority
   * over flags" (a body fetch parses none) and leaves the stored value alone.
   * `'[]'` is authoritative: the server really reports no flags.
   */
  flags?: string | null
  has_attachments?: number
  body_fetched?: number
  entities?: string | null
  list_unsubscribe?: string | null
  unsubscribe_one_click?: number
  bulk?: number
}
