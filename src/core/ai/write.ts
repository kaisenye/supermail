import type { Ai } from '../services/ai/service.js'
import { AiError, type AiRequest } from '../services/ai/types.js'
import { MAIL_IS_DATA } from './mailText.js'

export type WriteAction = 'draft' | 'shorten' | 'fix' | 'friendlier' | 'formal'
export const WRITE_ACTIONS: WriteAction[] = ['draft', 'shorten', 'fix', 'friendlier', 'formal']

export interface WriteInput {
  action: WriteAction
  /** The selection, or what the user wrote above the signature. */
  text: string
  /** Draft only: what to write. */
  instruction?: string
  /** Draft only: 'selection' replaces the selected text inside a longer email. */
  scope?: 'selection' | 'message'
  /** Draft only: the conversation being replied to (transcript()). */
  thread?: string
  myName?: string | null
}

const TRANSFORM: Record<Exclude<WriteAction, 'draft'>, string> = {
  shorten: 'Make this email text shorter and clearer. Keep every fact, request, name and date.',
  fix: 'Fix spelling, grammar and punctuation. Change nothing else.',
  friendlier: 'Rewrite this email text to sound warmer and friendlier. Keep the meaning.',
  formal: 'Rewrite this email text to sound more formal and professional. Keep the meaning.'
}

export function writeRequest(input: WriteInput): AiRequest {
  if (input.action === 'draft') {
    const what = input.instruction?.trim()
    if (!what) throw new AiError('invalid', 'Say what to write')
    if (input.scope === 'selection' && input.text.trim()) {
      return {
        system: [
          `You edit email text for the user${input.myName ? ` (${input.myName})` : ''}.`,
          'The text in <draft> is a selection inside a longer email.',
          'Reply with only the replacement text: no greeting, no sign-off, no commentary, unless asked for.',
          'Write in the language of the draft.',
          MAIL_IS_DATA
        ].join(' '),
        prompt: [
          input.thread ? `The conversation so far, oldest first:\n${input.thread}` : '',
          `<draft>\n${input.text.trim()}\n</draft>`,
          `Replace it with: ${what}`
        ]
          .filter(Boolean)
          .join('\n\n'),
        maxTokens: 4000
      }
    }
    return {
      system: [
        `You write email text for the user${input.myName ? ` (${input.myName})` : ''}.`,
        'Reply with the email body only: no subject line, no placeholders like [Name], no signature, no commentary.',
        'Write in the language of the conversation when there is one.',
        MAIL_IS_DATA
      ].join(' '),
      prompt: [
        input.thread ? `The conversation so far, oldest first:\n${input.thread}` : '',
        input.text.trim() ? `What the user has written so far:\n<draft>\n${input.text.trim()}\n</draft>` : '',
        `Write: ${what}`
      ]
        .filter(Boolean)
        .join('\n\n'),
      maxTokens: 4000
    }
  }
  if (!input.text.trim()) throw new AiError('invalid', 'There is no text to rewrite: select some, or write a few words first')
  return {
    system: [
      'You edit email text.',
      TRANSFORM[input.action],
      'Reply with the rewritten text only, in the same language, with no commentary.',
      MAIL_IS_DATA
    ].join(' '),
    prompt: `<draft>\n${input.text.trim()}\n</draft>`,
    maxTokens: 4000
  }
}

export async function writeWithAi(ai: Ai, input: WriteInput): Promise<string> {
  const r = await ai.run('write', writeRequest(input))
  return r.text.replace(/^\s*<draft>\s*/i, '').replace(/\s*<\/draft>\s*$/i, '').trim()
}
