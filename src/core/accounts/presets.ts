/**
 * Server settings inferred from the email domain, so most users never open
 * the Advanced section. Unknown domains fall back to the imap./smtp. guess,
 * which is right often enough to be worth offering as a prefill.
 */
export interface ProviderPreset {
  id: string
  label: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  /** Server files outgoing mail into Sent itself; an APPEND would duplicate it. */
  smtpSavesSent: boolean
  /** Shown under the password field when this provider needs a non-login password. */
  passwordHint?: string
}

const PRESETS: Array<{ match: RegExp; preset: ProviderPreset }> = [
  {
    // Exmail hosts custom domains, so the MX-style guess never catches it;
    // matched by server host rather than domain when the user picks it.
    match: /^(exmail\.qq\.com|qq\.com)$/i,
    preset: {
      id: 'exmail',
      label: 'Tencent Exmail',
      imapHost: 'imap.exmail.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.exmail.qq.com',
      smtpPort: 465,
      smtpSavesSent: true,
      passwordHint:
        'Exmail rejects your normal login password. Generate an app-specific password in the admin console.'
    }
  },
  {
    match: /^(gmail\.com|googlemail\.com)$/i,
    preset: {
      id: 'gmail',
      label: 'Gmail',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      // Gmail files SMTP sends into Sent automatically.
      smtpSavesSent: true,
      passwordHint:
        'Gmail requires an App Password with 2-Step Verification enabled — your account password will be rejected.'
    }
  },
  {
    match: /^(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i,
    preset: {
      id: 'outlook',
      label: 'Outlook',
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      smtpHost: 'smtp-mail.outlook.com',
      smtpPort: 587,
      smtpSavesSent: true
    }
  },
  {
    match: /^(fastmail\.com|fastmail\.fm)$/i,
    preset: {
      id: 'fastmail',
      label: 'Fastmail',
      imapHost: 'imap.fastmail.com',
      imapPort: 993,
      smtpHost: 'smtp.fastmail.com',
      smtpPort: 465,
      smtpSavesSent: false,
      passwordHint: 'Fastmail requires an app password created under Settings → Privacy & Security.'
    }
  },
  {
    match: /^(icloud\.com|me\.com|mac\.com)$/i,
    preset: {
      id: 'icloud',
      label: 'iCloud Mail',
      imapHost: 'imap.mail.me.com',
      imapPort: 993,
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
      smtpSavesSent: false,
      passwordHint: 'iCloud requires an app-specific password from appleid.apple.com.'
    }
  },
  {
    match: /^yahoo\.(com|co\.[a-z]{2}|[a-z]{2})$/i,
    preset: {
      id: 'yahoo',
      label: 'Yahoo Mail',
      imapHost: 'imap.mail.yahoo.com',
      imapPort: 993,
      smtpHost: 'smtp.mail.yahoo.com',
      smtpPort: 465,
      smtpSavesSent: true,
      passwordHint: 'Yahoo requires an app password generated in Account Security.'
    }
  },
  {
    match: /^(zoho\.com|zohomail\.com)$/i,
    preset: {
      id: 'zoho',
      label: 'Zoho Mail',
      imapHost: 'imap.zoho.com',
      imapPort: 993,
      smtpHost: 'smtp.zoho.com',
      smtpPort: 465,
      smtpSavesSent: false
    }
  }
]

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase()
}

/**
 * Best-guess settings for an address. Never throws: an unknown domain still
 * yields a usable prefill the user can correct under Advanced.
 */
export function presetFor(email: string): ProviderPreset {
  const domain = domainOf(email)
  for (const { match, preset } of PRESETS) {
    if (match.test(domain)) return preset
  }
  return {
    id: 'generic',
    label: domain || 'Custom',
    imapHost: domain ? `imap.${domain}` : '',
    imapPort: 993,
    smtpHost: domain ? `smtp.${domain}` : '',
    smtpPort: 465,
    smtpSavesSent: false
  }
}

/** Explicit picks in the UI, so a custom-domain Exmail user can self-identify. */
export function listPresets(): ProviderPreset[] {
  return PRESETS.map((p) => p.preset)
}

export function presetById(id: string): ProviderPreset | null {
  return PRESETS.find((p) => p.preset.id === id)?.preset ?? null
}
