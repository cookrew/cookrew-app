import {
  commitmentOf,
  grantDigest,
  grantNonce,
  mintGrantKey,
  openGrantCode,
  wordsOfGrant,
  type GrantAsked,
  type GrantDone,
  type GrantRefusal,
  type GrantStatus
} from '../../../shared/unlock-grant'
import type { UnlockVault } from './unlock-vault'

/**
 * THIS DEVICE'S SIDE OF SETTING UP UNLOCK (shared/unlock-grant.ts): no QR, no
 * trip to the Mac with this device. It commits to a fresh key, opens it once the
 * Mac has spoken, and shows the words someone compares on the Mac or on a device
 * that can already unlock it. The code it is then sent opens only with this
 * exchange's own key; anything else is refused and nothing is kept.
 */

export interface GrantApi {
  ask(commit: string): Promise<GrantAsked | GrantRefusal>
  reveal(id: string, key: string, nonce: string): Promise<GrantDone | GrantRefusal>
  status(id: string): Promise<GrantStatus | GrantRefusal>
}

export interface GrantSession {
  readonly id: string
  readonly macKey: string
  readonly unlockKey: string
  readonly digest: Uint8Array<ArrayBuffer>
  readonly privateKey: CryptoKey
  readonly words: readonly string[]
  readonly until: number
}

export type GrantStart = { readonly kind: 'waiting'; readonly session: GrantSession } | { readonly kind: 'error'; readonly message: string }

export type GrantPoll =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'done'; readonly code: string; readonly unlockKey: string; readonly by: string | null }
  | { readonly kind: 'denied'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

/** 32 bytes, base64url, as main/connect-code.ts writes it. */
const CODE = /^[A-Za-z0-9_-]{43}$/

export async function startGrant(api: GrantApi): Promise<GrantStart> {
  const mine = await mintGrantKey()
  const nonce = grantNonce()
  const asked = await api.ask(await commitmentOf(mine.publicKey, nonce))
  if (!asked.ok) return { kind: 'error', message: asked.error }
  const revealed = await api.reveal(asked.id, mine.publicKey, nonce)
  if (!revealed.ok) return { kind: 'error', message: revealed.error }
  const digest = await grantDigest({ id: asked.id, macKey: asked.macKey, macNonce: asked.macNonce, unlockKey: asked.unlockKey, phoneKey: mine.publicKey, phoneNonce: nonce })
  return {
    kind: 'waiting',
    session: { id: asked.id, macKey: asked.macKey, unlockKey: asked.unlockKey, digest, privateKey: mine.privateKey, words: wordsOfGrant(digest), until: asked.until }
  }
}

export async function pollGrant(api: GrantApi, session: GrantSession): Promise<GrantPoll> {
  const said = await api.status(session.id)
  if (!said.ok) return { kind: 'error', message: said.error }
  if (said.state === 'waiting') return { kind: 'waiting' }
  if (said.state === 'denied') return { kind: 'denied', message: said.by ? `Not allowed, by ${said.by}.` : 'Not allowed.' }
  if (said.state === 'expired') return { kind: 'denied', message: 'Nobody answered in time. Start again.' }
  const code = said.sealed ? await openGrantCode(session.privateKey, session.macKey, session.digest, said.sealed) : null
  if (code === null || !CODE.test(code)) return { kind: 'error', message: 'The answer did not open with this set-up’s key, so nothing was kept. Start again.' }
  return { kind: 'done', code, unlockKey: session.unlockKey, by: said.by ?? null }
}

/** Keeps what the exchange proved: the code for the sealed session, and the Mac's unlock key, checked by the same words. */
export async function keepGrant(done: { code: string; unlockKey: string }, deps: { saveCode: (code: string) => void; vault: UnlockVault; machine: string }): Promise<void> {
  deps.saveCode(done.code)
  const trust = await deps.vault.trust(deps.machine, done.unlockKey)
  if (trust === 'new') await deps.vault.pin(deps.machine, done.unlockKey)
  else if (trust === 'changed') await deps.vault.repin(deps.machine, done.unlockKey)
}
