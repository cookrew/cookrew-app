import { createPublicKey, verify } from 'node:crypto'
import { ANCHORS_PROOF_HEADER, ANCHORS_SKEW_MS, anchorsProofMessage } from '../../src/shared/account-pair'
import { FixedWindowLimiter } from '../../src/shared/fixed-window-limiter'
import { refuse, v2Json, type Signed, type V2Context } from './v2-http'
import { relyingParty } from './v2-factor-http'

/**
 * GET /v2/me/pair-anchors — WHAT A MACHINE OF THE ACCOUNT CHECKS AN ENTRY AGAINST.
 *
 * Owner 2026-11-09: a phone enters a machine of the account with the account's
 * password or a passkey, and the MACHINE decides (src/shared/account-pair.ts).
 * To decide it needs the account's passkeys (public keys, which the machine
 * pins on first use) and which device keys are the account's. NO PASSWORD
 * RECORD IS EVER SENT: a desktop checks a password against its own verifier,
 * so this registry cannot hand a machine a record it chose, and a session that
 * merely calls itself a desktop learns nothing it could guess at offline.
 *
 * Desktops only, with the desktop key's signature over a fresh line beside the
 * bearer, so a session token that leaked into a log reads nothing here.
 *
 * UNDER "NOT ME" THE ANSWER IS LOCKED: the owner said a stranger has the
 * password, so no machine may be entered with it, and the gate refuses widening
 * by passkey too (v2-step-up.ts) — entering a machine is widening.
 */

/** Far above a machine starting a few entries, far below a loop. */
const PER_DEVICE_PER_MINUTE = 30
const limiter = new FixedWindowLimiter(PER_DEVICE_PER_MINUTE)

/** `<ms>.<base64url signature>` over anchorsProofMessage, by the session's own device key. */
export function anchorsProofValid(
  header: string | string[] | undefined,
  device: { id: string; jwk: Record<string, string> },
  now: number
): boolean {
  if (typeof header !== 'string' || header.length > 512) return false
  const dot = header.indexOf('.')
  if (dot < 1) return false
  const at = Number(header.slice(0, dot))
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > ANCHORS_SKEW_MS) return false
  const sig = header.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return false
  try {
    const key = createPublicKey({ key: device.jwk as never, format: 'jwk' })
    const message = Buffer.from(anchorsProofMessage(device.id, at), 'utf8')
    const signature = Buffer.from(sig, 'base64url')
    return device.jwk.kty === 'OKP' ? verify(null, message, key, signature) : verify('sha256', message, key, signature)
  } catch {
    return false
  }
}

export function pairAnchorsRoute(ctx: V2Context, signed: Signed, now: number = Date.now()): void {
  const { account, device } = signed
  if (device.kind !== 'desktop') {
    refuse(ctx.response, 403, 'not_this_desktop')
    return
  }
  if (!anchorsProofValid(ctx.request.headers[ANCHORS_PROOF_HEADER], device, now)) {
    refuse(ctx.response, 401, 'unauthenticated')
    return
  }
  if (!limiter.take(device.id)) {
    refuse(ctx.response, 429, 'rate_limited')
    return
  }
  const locked = ctx.v2.factors.store.mustChangePassword(account.username)
  const passkeys = locked
    ? []
    : ctx.v2.factors.store
        .passkeys(account.username)
        .map((p) => ({ credentialId: p.credentialId, jwk: p.jwk, signCount: p.signCount }))
  ctx.response.setHeader('cache-control', 'private, no-store')
  v2Json(ctx.response, 200, {
    username: account.username,
    rpId: relyingParty(ctx).rpId,
    locked,
    passkeys,
    devices: account.devices.map((d) => ({ id: d.id, jwk: d.jwk }))
  })
}
