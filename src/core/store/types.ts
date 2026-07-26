export interface Account {
  id: number
  email: string
  imap_host: string | null
  imap_port: number | null
  smtp_host: string | null
  smtp_port: number | null
  auth_ref: string | null
}

export interface Folder {
  id: number
  account_id: number
  name: string | null
  path: string
  uidvalidity: number | null
  last_uid: number
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
  subject: string | null
  date: number | null
  snippet: string | null
  body_text: string | null
  body_html: string | null
  flags: string | null
  has_attachments: number
  body_fetched: number
  summary: string | null
  ai_labels: string | null
  embedding_id: number | null
  entities: string | null
  workflow_state: string | null
}

/** Envelope-only shape for list views — omits bodies so rows stay cheap. */
export type MessageListRow = Pick<
  Message,
  | 'id'
  | 'thread_id'
  | 'from_addr'
  | 'from_name'
  | 'subject'
  | 'date'
  | 'snippet'
  | 'flags'
  | 'has_attachments'
>

export interface UpsertMessageInput {
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
}
