import { REMEMBER_INFO, UNLOCK_PASSWORD_MAX, type UnlockAnswer, type UnlockBegin } from '../../../shared/remote-unlock'
import { sealForMac } from './unlock-seal'
import type { KeyTrust, RememberedBox, UnlockVault } from './unlock-vault'

/**
 * ONE UNLOCK, IN ORDER. The rule that matters: nothing is sealed or sent until
 * this device has decided it trusts the key, and a changed key sends nothing,
 * saved password or not.
 *
 * Two ways to remember (unlock-vault.ts):
 *   the Mac's own page   the password, under a non-extractable key (`plainRemember`), until lane D retires that page;
 *   the console (v2)     a box only the Mac opens, holding the password and the id the Mac issued for it. It is sent
 *                        only on an api that is a cookrew-seal/2 session (`sealedV2`), and the console never keeps
 *                        the password itself.
 */

export interface UnlockApi {
  begin(): Promise<UnlockBegin>
  send(sealed: string): Promise<UnlockAnswer>
  /** This api is a cookrew-seal/2 session (unlock-sealed.ts): the only road a remembered box is sent on. */
  readonly sealedV2?: boolean
  /** Gives a remembered password's id back to the Mac (the page's Forget): the route's answer, `ok` when it was heard. */
  forget?(id: string): Promise<{ readonly ok?: unknown }>
}

export interface UnlockFlowDeps {
  readonly api: UnlockApi
  readonly vault: UnlockVault
  readonly machine: string
  /** The id of the connect code this page holds: a box is kept and used under that code only. */
  readonly codeId?: string
  /** The Mac's own page: its plain Remember. Never on the console. */
  readonly plainRemember?: boolean
}

export type UnlockPrepared =
  | { readonly kind: 'ready'; readonly key: string; readonly trust: KeyTrust; readonly saved: boolean; readonly rememberable: boolean }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly message: string }

export type UnlockResult = { readonly kind: 'done' } | { readonly kind: 'changed'; readonly key: string } | { readonly kind: 'error'; readonly message: string }

/** The console's road for a box: a v2 session, and the code it was remembered under. */
const boxRoad = (deps: UnlockFlowDeps): string | null => (deps.api.sealedV2 === true && deps.codeId !== undefined ? deps.codeId : null)

/** A kept box, for a Mac whose begin says it remembers: one that no longer can is never sent a box it cannot read. */
const keptBox = async (deps: UnlockFlowDeps, opened: { readonly remember?: 1 }): Promise<RememberedBox | null> => {
  const code = boxRoad(deps)
  return code === null || opened.remember !== 1 ? null : deps.vault.boxFor(deps.machine, code)
}

const keptPassword = async (deps: UnlockFlowDeps): Promise<string | null> => (deps.plainRemember === true ? deps.vault.recall(deps.machine) : null)

/** Padded, so the sealed size says nothing about the password's length. */
const pad = (password: string): string => '0'.repeat(UNLOCK_PASSWORD_MAX - password.length)

/** Who this Mac says it is, before a password is typed. */
export async function prepareUnlock(deps: UnlockFlowDeps): Promise<UnlockPrepared> {
  const opened = await deps.api.begin()
  if (!opened.ok) return opened.outcome === 'not-locked' ? { kind: 'done' } : { kind: 'error', message: opened.error }
  const trust = await deps.vault.trust(deps.machine, opened.key)
  const saved = trust === 'same' && ((await keptBox(deps, opened)) !== null || (await keptPassword(deps)) !== null)
  return { kind: 'ready', key: opened.key, trust, saved, rememberable: boxRoad(deps) !== null && opened.remember === 1 }
}

/** What the page keeps once the Mac issued an id: the password and that id, sealed to the Mac, never the password. */
async function keepBox(deps: UnlockFlowDeps, key: string, password: string, id: string): Promise<void> {
  const code = boxRoad(deps)
  if (code === null) return
  try {
    const box = await sealForMac(key, JSON.stringify({ p: password, r: id, z: pad(password) }), REMEMBER_INFO)
    await deps.vault.keepBox(deps.machine, { box, id, code })
  } catch {
    // The Mac is open: a box this browser cannot keep is only a password not remembered, and its id goes back.
    await deps.api.forget?.(id).catch(() => undefined)
  }
}

export async function runUnlock(deps: UnlockFlowDeps, input: { readonly shownKey: string; readonly password: string | null; readonly remember: boolean }): Promise<UnlockResult> {
  const { api, vault, machine } = deps
  const opened = await api.begin()
  if (!opened.ok) return opened.outcome === 'not-locked' ? { kind: 'done' } : { kind: 'error', message: opened.error }
  // The key the reader saw, and the one pinned: a swap between the two sends nothing.
  const trust = await vault.trust(machine, opened.key)
  if (trust === 'changed' || opened.key !== input.shownKey) return { kind: 'changed', key: opened.key }
  const saved = input.password === null
  const box = saved ? await keptBox(deps, opened) : null
  const password = input.password ?? (box === null ? await keptPassword(deps) : null)
  if (box === null && (password === null || password.length === 0)) return { kind: 'error', message: 'Type this Mac’s password.' }
  if (password !== null && password.length > UNLOCK_PASSWORD_MAX) return { kind: 'error', message: 'That password is too long to send.' }
  // Remember is asked inside the seal, and only where a box can be kept.
  const asksToRemember = password !== null && input.remember && boxRoad(deps) !== null && opened.remember === 1
  const message = box !== null ? { c: opened.challenge, b: box.box } : { c: opened.challenge, p: password, z: pad(password ?? ''), ...(asksToRemember ? { m: 1 } : {}) }
  const sealed = await sealForMac(opened.key, JSON.stringify(message))
  if (trust === 'new') await vault.pin(machine, opened.key)
  const answer = await api.send(sealed)
  if (answer.ok) {
    if (asksToRemember && password !== null && typeof answer.remembered === 'string') await keepBox(deps, opened.key, password, answer.remembered)
    else if (input.remember && password !== null && deps.plainRemember === true) await vault.remember(machine, password)
    return { kind: 'done' }
  }
  if (answer.outcome === 'not-locked') return { kind: 'done' }
  // A remembered box the Mac took back, or one whose password stopped working: gone here too.
  if (box !== null && (answer.outcome === 'forgotten' || answer.outcome === 'wrong')) await vault.dropBox(machine)
  // A saved password that stopped working must not burn the Mac's attempts again.
  else if (answer.outcome === 'wrong' && saved) await vault.forgetPassword(machine)
  return { kind: 'error', message: answer.error }
}

/**
 * The sheet's Forget: whatever this device remembers for this Mac goes, and the Mac is given its id back. False when the
 * Mac could not be told: the box is gone from here all the same, and the sheet says so (the Mac drops the id when the
 * pairing rotates, or when this device is forgotten in Devices).
 */
export async function forgetRemembered(deps: UnlockFlowDeps): Promise<boolean> {
  await deps.vault.forgetPassword(deps.machine)
  const id = await deps.vault.dropBox(deps.machine)
  if (id === null || deps.api.forget === undefined) return true
  const said = await deps.api.forget(id).catch(() => null)
  return said?.ok === true
}
