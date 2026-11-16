import type http from 'node:http'
import { readJson, respondJson } from './mobile-http'
import type { PhoneInvite } from '../shared/join-code'

export type { PhoneInvite }

/**
 * ⋯ → PHONE APP (owner 2026-11-16): the QR the native phone app scans.
 *
 * The account's join code for a PHONE (registry v2-join.ts): the only code a
 * trusted phone is made by, and it makes nothing else. Scanned, the phone joins
 * the account and then enters every machine of it on its phone pass until it
 * is revoked — so minting one is the act that widens what the account opens
 * from, and it takes the account's step-up, the owner, and a sealed line (the
 * password must never cross the network in the clear).
 *
 * The route is for the web companion; the desktop asks over IPC (index.ts ·
 * 'phone:invite'), where a provider's trip may open on this Mac.
 */

/** Mint under this password. `here`: asked on this Mac, where a provider trip can open. */
export type PhoneInviter = (current: string, here: boolean) => Promise<PhoneInvite>

/** A module seam, as setWatchHost is: main lends the minter once accounts exist. */
let inviter: PhoneInviter | null = null

export function setPhoneInviter(next: PhoneInviter | null): void {
  inviter = next
}

export interface PhoneInviteRequest {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly method: string
  readonly path: string
  /** The owner's own pairing, never a watch's or a reader's. */
  readonly owner: boolean
  /** The line is sealed end to end (or loopback): a password may be read from it. */
  readonly sealed: () => boolean
}

const PATH = '/api/phone/invite'
/** A password and nothing else: far below anything worth streaming. */
const BODY_MAX = 4 * 1024

/** POST /api/phone/invite; false for anything else. */
export async function handlePhoneInviteRoute(ctx: PhoneInviteRequest): Promise<boolean> {
  if (ctx.method !== 'POST' || ctx.path !== PATH) return false
  if (!ctx.owner) {
    respondJson(ctx.response, 401, { error: 'Unauthorized' })
    return true
  }
  const mint = inviter
  if (mint === null) {
    respondJson(ctx.response, 503, { error: 'phone invites not wired' })
    return true
  }
  // Refused before the body is read: on a plain line the password has already crossed, and must not also be used.
  if (!ctx.sealed()) {
    respondJson(ctx.response, 200, { ok: false, reason: 'not_sealed' })
    return true
  }
  let current = ''
  try {
    const body = await readJson<{ current?: unknown }>(ctx.request, BODY_MAX)
    current = typeof body.current === 'string' ? body.current : ''
  } catch {
    respondJson(ctx.response, 400, { ok: false, reason: 'malformed' })
    return true
  }
  try {
    // Never a provider trip from here: it would open on this Mac, which nobody holding the phone may be looking at.
    respondJson(ctx.response, 200, await mint(current, false))
  } catch (error) {
    console.error('Minting a code for the phone app failed:', error)
    respondJson(ctx.response, 200, { ok: false, reason: 'unknown' })
  }
  return true
}
