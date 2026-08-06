import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { AccountConfig } from './config.js'
import { presetFor } from './presets.js'

export interface VerifyResult {
  ok: boolean
  /** Which leg failed, so the form can highlight the right fields. */
  stage?: 'imap' | 'smtp'
  message?: string
  /** Mailbox count on success — cheap proof the account is really readable. */
  mailboxes?: number
}

/**
 * Server errors are written for operators, not users: Exmail answers a wrong
 * password with a bare "AUTHENTICATIONFAILED" and Gmail with a support URL.
 * Translate the common ones into the action the user has to take.
 */
function explain(err: unknown, stage: 'imap' | 'smtp', config: AccountConfig): string {
  const e = err as {
    message?: string
    code?: string
    responseText?: string
    authenticationFailed?: boolean
  }
  // imapflow sets message to a bare "Command failed" and puts the server's
  // actual words in responseText, so both have to be considered.
  const raw = [e?.responseText, e?.message].filter(Boolean).join(' ') || String(err ?? '')
  const code = e?.code ?? ''
  const hint = presetFor(config.email).passwordHint

  if (
    e?.authenticationFailed ||
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Login fail|535|534|Username and Password not accepted/i.test(
      raw
    )
  ) {
    // Exmail answers every auth failure with one catch-all string naming
    // several possible causes, so it cannot narrow this further than the hint.
    return hint
      ? `Server rejected the password. ${hint}`
      : 'Server rejected the email or password. Check both, and whether this host needs an app-specific password.'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw) || code === 'ENOTFOUND') {
    const host = stage === 'imap' ? config.imapHost : config.smtpHost
    // The guessed imap.<domain> misses hosted providers, which is exactly the
    // case a custom-domain user hits first.
    return `Cannot find server "${host}". Check the hostname under Advanced — a hosted provider often uses its own (Exmail, for example, uses imap.exmail.qq.com).`
  }
  if (/ECONNREFUSED/i.test(raw) || code === 'ECONNREFUSED') {
    const port = stage === 'imap' ? config.imapPort : config.smtpPort
    return `Connection refused on port ${port}. Check the port under Advanced.`
  }
  if (/ETIMEDOUT|timed? ?out/i.test(raw) || code === 'ETIMEDOUT') {
    return 'Connection timed out. The server may be unreachable from this network, or the port may be wrong.'
  }
  if (/self.signed|certificate|SSL|TLS|wrong version number/i.test(raw)) {
    return 'TLS handshake failed. The port may expect STARTTLS rather than implicit TLS — check the port under Advanced.'
  }
  if (/IMAP.*disabled|not enabled/i.test(raw)) {
    return 'IMAP is disabled for this account. Enable it in your mail provider settings.'
  }
  return raw || 'Connection failed.'
}

const TIMEOUT_MS = 20_000

/** IMAP login + LIST. Proves credentials and that IMAP is actually enabled. */
async function verifyImap(config: AccountConfig): Promise<number> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.email, pass: config.pass },
    logger: false,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS
  })
  await client.connect()
  try {
    return (await client.list()).length
  } finally {
    await client.logout().catch(() => {})
  }
}

/** SMTP verify() authenticates without sending anything. */
async function verifySmtp(config: AccountConfig): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.email, pass: config.pass },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS
  })
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

/**
 * Checks both legs before an account is ever saved, so a typo surfaces here
 * rather than as mail that silently fails to send days later.
 */
export async function verifyAccount(config: AccountConfig): Promise<VerifyResult> {
  let mailboxes: number
  try {
    mailboxes = await verifyImap(config)
  } catch (err) {
    return { ok: false, stage: 'imap', message: explain(err, 'imap', config) }
  }
  try {
    await verifySmtp(config)
  } catch (err) {
    // IMAP already succeeded, so the password is right — this is a server or
    // port problem, and saying so avoids sending the user back to the password.
    return { ok: false, stage: 'smtp', message: explain(err, 'smtp', config) }
  }
  return { ok: true, mailboxes }
}
