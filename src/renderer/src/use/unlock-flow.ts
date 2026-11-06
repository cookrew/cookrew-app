import { UNLOCK_PASSWORD_MAX, type UnlockAnswer, type UnlockBegin } from '../../../shared/remote-unlock'
import { sealForMac } from './unlock-seal'
import type { KeyTrust, UnlockVault } from './unlock-vault'

/**
 * ONE UNLOCK, IN ORDER. The rule that matters: nothing is sealed or sent until
 * this device has decided it trusts the key, and a changed key sends nothing,
 * saved password or not.
 */

export interface UnlockApi {
  begin(): Promise<UnlockBegin>
  send(sealed: string): Promise<UnlockAnswer>
}

export interface UnlockFlowDeps {
  readonly api: UnlockApi
  readonly vault: UnlockVault
  readonly machine: string
}

export type UnlockPrepared =
  | { readonly kind: 'ready'; readonly key: string; readonly trust: KeyTrust; readonly saved: boolean }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string }

export type UnlockResult = { readonly kind: 'done' } | { readonly kind: 'changed'; readonly key: string } | { readonly kind: 'error'; readonly message: string }

/** Who this Mac says it is, before a password is typed. */
export async function prepareUnlock({ api, vault, machine }: UnlockFlowDeps): Promise<UnlockPrepared> {
  const opened = await api.begin()
  if (!opened.ok) return opened.outcome === 'not-locked' ? { kind: 'done' } : { kind: 'error', message: opened.error }
  const trust = await vault.trust(machine, opened.key)
  return { kind: 'ready', key: opened.key, trust, saved: trust === 'same' && (await vault.recall(machine)) !== null }
}

export async function runUnlock(deps: UnlockFlowDeps, input: { readonly shownKey: string; readonly password: string | null; readonly remember: boolean }): Promise<UnlockResult> {
  const { api, vault, machine } = deps
  const opened = await api.begin()
  if (!opened.ok) return opened.outcome === 'not-locked' ? { kind: 'done' } : { kind: 'error', message: opened.error }
  // The key the reader saw, and the one pinned: a swap between the two sends nothing.
  const trust = await vault.trust(machine, opened.key)
  if (trust === 'changed' || opened.key !== input.shownKey) return { kind: 'changed', key: opened.key }
  const saved = input.password === null
  const password = input.password ?? (await vault.recall(machine))
  if (password === null || password.length === 0) return { kind: 'error', message: 'Type this Mac’s password.' }
  if (password.length > UNLOCK_PASSWORD_MAX) return { kind: 'error', message: 'That password is too long to send.' }
  // Padded, so the sealed size says nothing about the password's length.
  const sealed = await sealForMac(opened.key, JSON.stringify({ c: opened.challenge, p: password, z: '0'.repeat(UNLOCK_PASSWORD_MAX - password.length) }))
  if (trust === 'new') await vault.pin(machine, opened.key)
  const answer = await api.send(sealed)
  if (answer.ok) {
    if (input.remember) await vault.remember(machine, password)
    return { kind: 'done' }
  }
  if (answer.outcome === 'not-locked') return { kind: 'done' }
  // A saved password that stopped working must not burn the Mac's attempts again.
  if (answer.outcome === 'wrong' && saved) await vault.forgetPassword(machine)
  return { kind: 'error', message: answer.error }
}
