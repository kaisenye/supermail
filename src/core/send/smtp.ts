import nodemailer from 'nodemailer'
import { formatFromHeader, type AccountConfig } from '../accounts/config.js'

export interface OutboundAttachment {
  path: string
  filename: string
  contentType: string
}

export interface OutboundInline {
  contentId: string
  filename: string
  contentType: string
  content: Buffer
}

export interface OutboundMail {
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
  html?: string
  inReplyTo?: string | null
  references?: string | null
  messageId?: string
  attachments?: OutboundAttachment[]
  inline?: OutboundInline[]
}

export async function sendSmtp(
  config: AccountConfig,
  mail: OutboundMail
): Promise<{ messageId: string }> {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.email, pass: config.pass }
  })

  const info = await transport.sendMail({
    from: formatFromHeader(config),
    to: mail.to,
    cc: mail.cc || undefined,
    bcc: mail.bcc || undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html || undefined,
    inReplyTo: mail.inReplyTo || undefined,
    references: mail.references || undefined,
    messageId: mail.messageId,
    // nodemailer takes inline images in the same array; a `cid` is what makes
    // it emit multipart/related instead of a plain attachment.
    attachments: mail.attachments?.length || mail.inline?.length
      ? [
          ...(mail.attachments ?? []).map((a) => ({
            path: a.path,
            filename: a.filename,
            contentType: a.contentType
          })),
          ...(mail.inline ?? []).map((i) => ({
            cid: i.contentId,
            filename: i.filename,
            contentType: i.contentType,
            content: i.content
          }))
        ]
      : undefined
  })

  await transport.close()
  const messageId = String(info.messageId ?? mail.messageId ?? '')
  return { messageId }
}
