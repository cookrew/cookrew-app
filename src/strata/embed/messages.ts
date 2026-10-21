// The dive's handoff, checked both ways (src/shared/strata.ts ShellToEmbed /
// EmbedToShell). A message counts only when it comes from the page's OWN
// origin AND from the one window it is expected from — the iframe's
// contentWindow for the shell, window.parent for the embed. Anything else is
// dropped without a word: a message is never an error the other side can
// provoke.
import type { EmbedToShell, ShellToEmbed } from '../../shared/strata'

export interface MessageLike {
  origin: string
  source: unknown
  data: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isId = (value: unknown): value is string => typeof value === 'string' && value.length <= 200

const ERROR_CODES = new Set(['not-found', 'offline', 'unauthorized', 'unreachable'])

/**
 * LOCAL WORKAROUND, asked of Revel: a document booted WITHOUT an agent (a
 * prewarm) says so with `strata:ready` and an EMPTY agentId — the contract has
 * no "warm" message yet, and the shell must know the listener is up before it
 * sends a focus.
 */
export const WARM_AGENT_ID = ''

export const parseEmbedToShell = (data: unknown): EmbedToShell | null => {
  if (!isObject(data)) return null
  switch (data.type) {
    case 'strata:ready':
      return isId(data.agentId) ? { type: 'strata:ready', agentId: data.agentId } : null
    case 'strata:out':
      return { type: 'strata:out' }
    case 'strata:error':
      if (typeof data.code !== 'string' || !ERROR_CODES.has(data.code)) return null
      return {
        type: 'strata:error',
        code: data.code as Extract<EmbedToShell, { type: 'strata:error' }>['code'],
        ...(typeof data.detail === 'string' ? { detail: data.detail.slice(0, 200) } : {})
      }
    default:
      return null
  }
}

export const parseShellToEmbed = (data: unknown): ShellToEmbed | null => {
  if (!isObject(data)) return null
  if (data.type === 'strata:blur') return { type: 'strata:blur' }
  if (data.type !== 'strata:focus' || !isId(data.agentId) || data.agentId.length === 0) return null
  return isId(data.attachmentId)
    ? { type: 'strata:focus', agentId: data.agentId, attachmentId: data.attachmentId }
    : { type: 'strata:focus', agentId: data.agentId }
}

/** The shell's check: our origin, and exactly that frame's window. */
export const fromFrame = (event: MessageLike, origin: string, frameWindow: unknown): EmbedToShell | null =>
  event.origin === origin && frameWindow !== null && event.source === frameWindow ? parseEmbedToShell(event.data) : null

/** The embed's check: our origin, and exactly our parent — never ourselves, never a sibling. */
export const fromShell = (event: MessageLike, origin: string, parent: unknown, self: unknown): ShellToEmbed | null =>
  event.origin === origin && parent !== self && event.source === parent ? parseShellToEmbed(event.data) : null
