/**
 * THE GATE (0.6.0): one proof, twelve hours, every machine.
 *
 * Signed in, the console knows the account's machines by name. To see inside
 * any of them the person proves it is them once, and the registry answers
 * with a twelve-hour pass bound to this browser's key (the "device pass",
 * `cr_grant`); each machine's door then lets this browser in on that pass
 * (account-pair-client.ts · enterWithGrant).
 *
 * THE PROOF IS A PASSKEY TOUCHED HERE, OR THE PASSWORD TYPED ELSEWHERE. This
 * is the page that draws what machines send it and keeps tokens where a
 * script could read them, so the account password is never typed on it: that
 * way goes to auth.cookrew.dev and comes back with the pass (decision F5,
 * console-session.ts · passByPassword). A passkey answers one challenge and
 * leaves nothing to steal, so it is used in place.
 */
import { GRANT_MARGIN_MS, type DeviceGrant, type GrantOptions } from '../../../shared/account-pair'
import { grantOptions, heldGrant, proveForGrant, type GrantStore, type Http } from '../account-pair-client'
import type { StartResult } from './console-session'

export const GATE_COPY = {
  needsPassword: 'This account has no password and no passkey yet. Add one in Account & security, then come back.',
  unreachable: 'Cookrew’s registry is not answering. Try again in a moment.',
  noKey: 'This browser has no key for Cookrew. Sign in again.',
  notThisBrowser: 'That was confirmed for another browser. Try again here.'
} as const

export interface GateWays {
  readonly passkey: boolean
  readonly password: boolean
}

export type GateState =
  | { readonly status: 'unknown' }
  | { readonly status: 'closed'; readonly ways: GateWays | null; readonly line: string | null; readonly busy: boolean }
  | { readonly status: 'open'; readonly until: number }

export interface GateDeps {
  /** The registry's API, with the console's session. */
  readonly registry: Http
  /** This browser's device id, or null when it has no key. */
  readonly deviceId: () => Promise<string | null>
  readonly passkey: ((options: CredentialRequestOptions) => Promise<Credential | null>) | null
  readonly grants: GrantStore
  /** The password, typed on the auth host: leaves this page. */
  readonly passwordElsewhere: (returnTo: string) => Promise<StartResult>
  readonly now?: () => number
}

export interface ConsoleGate {
  get(): GateState
  subscribe(listener: () => void): () => void
  /** Is a pass held for this browser's key; if not, how this account can get one. */
  check(): Promise<void>
  withPasskey(): Promise<void>
  withPassword(returnTo: string): Promise<void>
  /** A pass that came back from the auth host. */
  took(grant: DeviceGrant): Promise<void>
  /** Signed out: no pass, and nothing known. */
  forget(): void
}

export function createConsoleGate(deps: GateDeps): ConsoleGate {
  const now = deps.now ?? Date.now
  const listeners = new Set<() => void>()
  let state: GateState = { status: 'unknown' }
  let options: GrantOptions | null = null
  let closing: ReturnType<typeof setTimeout> | null = null

  /** Bumped by `forget`: a check or a proof that was out when the person signed out opens nothing. */
  let generation = 0

  const set = (next: GateState): void => {
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    for (const listener of listeners) listener()
  }

  const waysOf = (held: GrantOptions): GateWays => ({ passkey: held.methods.passkey && held.passkey !== null && deps.passkey !== null, password: held.methods.password })

  const closed = (line: string | null, busy = false): void =>
    set({ status: 'closed', ways: options === null ? null : waysOf(options), line: line ?? (options?.needsPassword ? GATE_COPY.needsPassword : null), busy })

  /** How this account proves itself; a passkey challenge is good for one touch, so this is asked again after each. */
  const askWays = async (mine = generation): Promise<void> => {
    const asked = await grantOptions(deps.registry)
    if (mine !== generation) return
    options = asked
    closed(options === null ? GATE_COPY.unreachable : null)
  }

  const open = (grant: DeviceGrant): void => {
    if (closing !== null) clearTimeout(closing)
    closing = setTimeout(() => {
      closing = null
      void check()
    }, Math.max(0, grant.exp - now() - GRANT_MARGIN_MS))
    set({ status: 'open', until: grant.exp })
  }

  const check = async (): Promise<void> => {
    const mine = generation
    const deviceId = await deps.deviceId().catch(() => null)
    if (mine !== generation) return
    if (deviceId === null) {
      options = null
      return closed(GATE_COPY.noKey)
    }
    const held = heldGrant(deps, deviceId)
    if (held !== null) return open(held)
    if (closing !== null) clearTimeout(closing)
    closing = null
    await askWays(mine)
  }

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    check,
    withPasskey: async () => {
      if (state.status !== 'closed' || state.busy) return
      if (options === null) await askWays()
      if (options === null || !waysOf(options).passkey) return
      const mine = generation
      closed(null, true)
      const result = await proveForGrant({ ...deps, machine: deps.registry, device: async () => null }, null, options).catch(() => ({ kind: 'failed' as const, message: GATE_COPY.unreachable }))
      if (mine !== generation) return
      if (result.kind === 'granted') return check()
      // The challenge is spent by a touch that reached the registry: the next touch needs a new one.
      if (result.kind === 'cancelled') return closed(null)
      const said = result.kind === 'needs-password' ? GATE_COPY.needsPassword : result.message
      const next = await grantOptions(deps.registry)
      if (mine !== generation) return
      options = next
      closed(said)
    },
    withPassword: async (returnTo) => {
      if (state.status !== 'closed' || state.busy) return
      const mine = generation
      closed(null, true)
      const started = await deps.passwordElsewhere(returnTo).catch(() => ({ ok: false as const, message: GATE_COPY.unreachable }))
      if (mine !== generation) return
      // Started, the browser is leaving this page. Should it come back to this very page (kept
      // whole by the browser), the button must work again: not busy for long.
      if (!started.ok) return closed(started.message)
      setTimeout(() => {
        if (mine === generation && state.status === 'closed' && state.busy) closed(null)
      }, 4_000)
    },
    took: async (grant) => {
      const deviceId = await deps.deviceId().catch(() => null)
      if (deviceId === null || grant.deviceId !== deviceId) {
        if (state.status !== 'open') closed(GATE_COPY.notThisBrowser)
        return
      }
      deps.grants.write(grant)
      await check()
    },
    forget: () => {
      generation += 1
      if (closing !== null) clearTimeout(closing)
      closing = null
      options = null
      deps.grants.clear()
      set({ status: 'unknown' })
    }
  }
}
