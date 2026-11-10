/**
 * THE MACHINE THIS PAGE IS TALKING TO, AND HOW TO CHANGE IT WITHOUT A RELOAD
 * (0.6.0).
 *
 * The web client used to be loaded once per machine: a machine served the
 * page, and "which machine" was a constant read at module load. A great deal
 * of state was therefore kept in module-level variables with no key at all:
 * the transport, the pairing token, the event stream, the agents' activity,
 * what is typed into each line. The console is ONE document for every machine
 * of the account, so that question is now a value that changes, here.
 *
 * TWO KINDS OF PAGE:
 *
 *   a machine's own page   served by one machine on its network, for a
 *                          machine with no account. No relay, no machine id:
 *                          it talks to whoever served it, at its own origin.
 *                          This scope never changes.
 *   the console            hosted elsewhere. It reaches the account's machines
 *                          through the registry's one relay path
 *                          (`<api origin>/api/m/<machine id>/…`), one machine
 *                          in scope at a time, or none (the Devices level).
 *
 * ENTERING ANOTHER MACHINE IS A SOFT RELOAD. Every piece of state that belongs
 * to a machine registers a way to let go of it (`registerScopeState`), and
 * `enterMachine` runs them all, in two phases: first what TALKS is stopped
 * (streams, timers, links: a stream left open would keep feeding the page the
 * old machine's events), then what HOLDS is cleared. Both run while the old
 * machine is still in scope, so a teardown that needs to say goodbye still
 * knows to whom. State is re-read lazily under the new scope; nothing is
 * carried across.
 *
 * WHAT IS NOT HERE: anything keyed by a machine's own id (another machine's
 * last cards, a draft typed for it), and anything that is the browser's or the
 * person's (theme, the account pass, the device key). Those are safe to share.
 */

import { MACHINE_RELAY_PREFIX, RELAY_SESSION_HEADER, isMachineId } from '../../shared/machine-relay'

/** How the console reaches the account's machines. */
export interface RelayAccess {
  /** The registry's API origin, e.g. `https://api.cookrew.dev`. */
  readonly origin: string
  /** The account session, read at each request (it is renewed every few minutes). Null when signed out. */
  readonly session: () => string | null
}

export interface MachineScope {
  /** The machine in scope, by its registry id. Null on a machine's own page, and on the console before one is entered. */
  readonly machineId: string | null
  /** Null on a machine's own page. */
  readonly relay: RelayAccess | null
  /** The workspace this page was served for, on a machine's own page under `/<slug>`; '' otherwise. */
  readonly slug: string
}

/** What talks is stopped first; what holds is cleared after. */
export const SCOPE_PHASES = ['stop', 'clear'] as const
export type ScopePhase = (typeof SCOPE_PHASES)[number]

const injectedSlug = (): string => {
  const injected = (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
  return typeof injected === 'string' ? injected : ''
}

/** A machine's own page: what every client is until something says it is the console. */
const ownPage = (): MachineScope => ({ machineId: null, relay: null, slug: injectedSlug() })

let scope: MachineScope = ownPage()
let epoch = 0
const listeners = new Set<(next: MachineScope) => void>()
const states = new Map<string, { phase: ScopePhase; reset: () => void }>()

export const machineScope = (): MachineScope => scope

/** Bumped at every change of machine: a view keyed by it is remounted for the machine it now shows. */
export const scopeEpoch = (): number => epoch

export function subscribeMachineScope(listener: (next: MachineScope) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Is this the console: a page that must name a machine before it can ask one anything. */
export const scopeNeedsMachine = (current: MachineScope = scope): boolean => current.relay !== null

const trimmed = (origin: string): string => origin.replace(/\/+$/, '')

/**
 * Where one machine of the account answers on the relay, or null: on a page
 * with no relay, or for an id that is not a machine's. Built from the
 * configured origin and a checked id, never from anything else.
 */
export function machineBaseOf(machineId: string, current: MachineScope = scope): string | null {
  const id = machineId.toLowerCase()
  if (current.relay === null || !isMachineId(id)) return null
  return `${trimmed(current.relay.origin)}${MACHINE_RELAY_PREFIX}/${id}`
}

/**
 * The prefix of every request to the machine in scope on the relay plane: ''
 * on a machine's own page (same origin, its own root), the machine's relay
 * address on the console, and '' on the console with no machine in scope,
 * where nothing may be asked (api-base.ts refuses to build a path then).
 */
export function scopeBase(current: MachineScope = scope): string {
  return current.machineId === null ? '' : (machineBaseOf(current.machineId, current) ?? '')
}

/**
 * What the relay needs beside a machine's own token: the account session, in
 * its own header. ONLY EVER FOR THE RELAY. A request sent straight to a
 * machine must not carry it (plane-fetch.ts adds this on the relay plane and
 * nowhere else): a machine has no business holding the account's session.
 */
export function relayHeadersFor(current: MachineScope = scope): Record<string, string> {
  const session = current.relay?.session() ?? null
  return session === null || session === '' ? {} : { [RELAY_SESSION_HEADER]: session }
}

/**
 * A piece of state that belongs to the machine in scope, and how to let go of
 * it. Registered once, by name, at module load. `stop` for what talks (a
 * stream, a timer, a link), `clear` for what holds.
 */
export function registerScopeState(name: string, reset: () => void, phase: ScopePhase = 'clear'): void {
  states.set(name, { phase, reset })
}

/** Every registered state, by name (tests hold this list to what the page really keeps). */
export const scopeStates = (): readonly string[] => [...states.keys()]

/**
 * This page is the console: it reaches machines through the relay. Said once,
 * at boot, before anything is asked of a machine; it lets go of nothing,
 * because nothing is held yet.
 */
export function configureMachineScope(next: { relay: RelayAccess }): void {
  scope = { machineId: null, relay: { origin: trimmed(next.relay.origin), session: next.relay.session }, slug: '' }
}

/**
 * Enter a machine of the account, or none. Everything held for the machine
 * being left is let go first; a state that fails to let go does not stop the
 * others or the change (a page stuck between two machines is the worse
 * outcome). The machine's own page has one machine and never calls this.
 */
export function enterMachine(machineId: string | null): void {
  const id = machineId === null ? null : machineId.toLowerCase()
  if (id !== null && !isMachineId(id)) throw new Error('not a machine id')
  if (id !== null && scope.relay === null) throw new Error('this page reaches one machine only: the one that served it')
  if (id === scope.machineId) return
  for (const phase of SCOPE_PHASES) {
    for (const state of states.values()) {
      if (state.phase !== phase) continue
      try {
        state.reset()
      } catch {
        // Let go of the rest: one store that failed must not leave the others holding the old machine.
      }
    }
  }
  scope = { ...scope, machineId: id }
  epoch += 1
  for (const listener of listeners) listener(scope)
}

/** Test seam: a machine's own page again, with nothing registered and nobody listening. */
export function resetMachineScopeForTests(): void {
  scope = ownPage()
  epoch = 0
  listeners.clear()
  states.clear()
}
