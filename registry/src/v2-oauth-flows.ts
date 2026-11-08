import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { OAuthBack, OAuthIntent, ProviderId } from '../../src/shared/oauth'
import type { StepUpAct } from '../../src/shared/step-up'
import type { ProviderProof } from './v2-oauth-providers'

/**
 * A TRIP THROUGH A PROVIDER THAT IS HALF DONE.
 *
 * In memory for the reason `v2-pending.ts` gives: this is a fact about a
 * conversation, not an account, and a restart ending every conversation in
 * flight is correct. Nothing a provider said touches a disk until a person
 * has finished.
 *
 * THREE SECRETS, THREE JOBS, AND NONE OF THEM IS THE OTHER.
 *
 *   `providerState` goes to the provider and comes back on the callback. It is
 *   how the callback finds its flow and it is single use.
 *
 *   `handoff` goes back through the browser to the app. It is single use, two
 *   minutes long, and worth nothing alone, because another app can claim the
 *   `cookrew://` scheme and read it.
 *
 *   `challenge` is what makes that safe: the app keeps the verifier and it never
 *   crosses the browser, so only the process that began the flow can redeem.
 *
 * Every lookup that fails reads as gone. A caller is never told which check
 * refused, because that is a map of how to pass it.
 */

const FLOW_TTL_MS = 10 * 60 * 1000
/** Long enough to switch windows; a handoff is a moment. */
const HANDOFF_TTL_MS = 2 * 60 * 1000
/** Long enough to think of a name. */
const TICKET_TTL_MS = 10 * 60 * 1000
/** More flows than a busy hour has; a stranger cannot make this grow without bound. */
const FLOWS_MAX = 1000
const TICKETS_MAX = 1000

export interface FlowOpener {
  username: string
  jti: string
  device: string
}

export interface Flow {
  id: string
  provider: ProviderId
  intent: OAuthIntent
  act?: StepUpAct
  providerState: string
  /** The client's own CSRF token, echoed so the app can drop what it did not start. */
  clientState: string
  challenge: string
  providerVerifier: string
  nonce: string
  back: OAuthBack
  opener?: FlowOpener
  /** Opened on the auth origin: the callback finishes that request, never an app's handoff. */
  authRequest?: string
  at: number
  expiresAt: number
}

export interface DeviceFlow {
  id: string
  provider: ProviderId
  deviceCode: string
  challenge: string
  intervalMs: number
  nextPollAt: number
  expiresAt: number
}

export interface Settled {
  flow: Flow
  proof: ProviderProof
  handoff: string
  expiresAt: number
}

export interface Ticket {
  id: string
  proof: ProviderProof
  expiresAt: number
  /** Minted for a request on the auth origin: only that request may spend it. */
  authRequest?: string
}

const secret = (): string => randomBytes(32).toString('base64url')

/** The S256 challenge for a verifier. */
export const challengeFor = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

/** Compared without a timing edge. */
export function challengeMatches(challenge: string, verifier: unknown): boolean {
  if (typeof verifier !== 'string' || verifier === '') return false
  const computed = Buffer.from(challengeFor(verifier))
  const stored = Buffer.from(challenge)
  return computed.length === stored.length && timingSafeEqual(computed, stored)
}

/** Drop the oldest entry of a bounded map. Maps iterate in insertion order. */
function dropOldest<V>(map: Map<string, V>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next()
    if (oldest.done === true) return
    map.delete(oldest.value)
  }
}

export class OAuthFlows {
  private readonly now: () => number
  private flows = new Map<string, Flow>()
  private settled = new Map<string, Settled>()
  private tickets = new Map<string, Ticket>()
  private devices = new Map<string, DeviceFlow>()

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  open(input: Pick<Flow, 'provider' | 'intent' | 'act' | 'clientState' | 'challenge' | 'back' | 'opener' | 'authRequest'>): Flow {
    const at = this.now()
    this.sweep(at)
    dropOldest(this.flows, FLOWS_MAX)
    const flow: Flow = {
      ...input,
      id: randomUUID(),
      providerState: secret(),
      providerVerifier: secret(),
      nonce: secret(),
      at,
      expiresAt: at + FLOW_TTL_MS
    }
    this.flows.set(flow.providerState, flow)
    return flow
  }

  /** Take the flow a callback names. Taken, so a replayed callback finds nothing. */
  take(providerState: unknown, provider: ProviderId): Flow | null {
    if (typeof providerState !== 'string') return null
    const flow = this.flows.get(providerState)
    if (flow === undefined) return null
    this.flows.delete(providerState)
    if (flow.provider !== provider || this.now() >= flow.expiresAt) return null
    return flow
  }

  /** The provider has answered: mint the one thing that travels back. */
  settle(flow: Flow, proof: ProviderProof): Settled {
    const at = this.now()
    dropOldest(this.settled, FLOWS_MAX)
    const settled: Settled = { flow, proof, handoff: secret(), expiresAt: at + HANDOFF_TTL_MS }
    this.settled.set(settled.handoff, settled)
    return settled
  }

  /**
   * SPEND A HANDOFF. Burned on the first presentation whatever the verifier
   * was: a wrong verifier is somebody who caught the link and not the app, and
   * the real app can start again where a thief must not get a second go.
   */
  redeem(handoff: unknown, verifier: unknown): Settled | null {
    if (typeof handoff !== 'string') return null
    const settled = this.settled.get(handoff)
    if (settled === undefined) return null
    this.settled.delete(handoff)
    if (this.now() >= settled.expiresAt) return null
    return challengeMatches(settled.flow.challenge, verifier) ? settled : null
  }

  // ── tickets: a proven identity with no account yet ───────────────────────

  mintTicket(proof: ProviderProof, authRequest?: string): Ticket {
    const at = this.now()
    this.sweep(at)
    dropOldest(this.tickets, TICKETS_MAX)
    const ticket: Ticket = {
      id: secret(),
      proof,
      expiresAt: at + TICKET_TTL_MS,
      ...(authRequest === undefined ? {} : { authRequest })
    }
    this.tickets.set(ticket.id, ticket)
    return ticket
  }

  /** Read without spending: a name that clashes asks again on the same ticket. */
  ticket(id: unknown): Ticket | null {
    if (typeof id !== 'string') return null
    const held = this.tickets.get(id)
    if (held === undefined) return null
    if (this.now() >= held.expiresAt) {
      this.tickets.delete(id)
      return null
    }
    return held
  }

  spendTicket(id: string): void {
    this.tickets.delete(id)
  }

  // ── the device flow ──────────────────────────────────────────────────────

  openDevice(input: Pick<DeviceFlow, 'provider' | 'deviceCode' | 'challenge' | 'intervalMs'> & { expiresInMs: number }): DeviceFlow {
    const at = this.now()
    this.sweep(at)
    dropOldest(this.devices, FLOWS_MAX)
    const { expiresInMs, ...rest } = input
    const flow: DeviceFlow = {
      ...rest,
      id: randomUUID(),
      nextPollAt: at,
      expiresAt: at + Math.min(expiresInMs, FLOW_TTL_MS * 2)
    }
    this.devices.set(flow.id, flow)
    return flow
  }

  device(id: unknown): DeviceFlow | null {
    if (typeof id !== 'string') return null
    const flow = this.devices.get(id)
    if (flow === undefined) return null
    if (this.now() >= flow.expiresAt) {
      this.devices.delete(id)
      return null
    }
    return flow
  }

  /** May the provider be asked yet? Answering yes books the next slot. */
  mayPoll(flow: DeviceFlow): boolean {
    const at = this.now()
    if (at < flow.nextPollAt) return false
    this.devices.set(flow.id, { ...flow, nextPollAt: at + flow.intervalMs })
    return true
  }

  /** The provider said slow down: the interval it named is now the rule. */
  slowDown(flow: DeviceFlow, intervalMs: number): void {
    const held = this.devices.get(flow.id)
    if (held === undefined) return
    this.devices.set(flow.id, { ...held, intervalMs, nextPollAt: this.now() + intervalMs })
  }

  closeDevice(id: string): void {
    this.devices.delete(id)
  }

  /** For a test: the interval is a real five seconds, and a test cannot wait it out. */
  allowPollNow(id: string): void {
    const held = this.devices.get(id)
    if (held !== undefined) this.devices.set(id, { ...held, nextPollAt: this.now() })
  }

  private sweep(at: number): void {
    for (const [key, flow] of this.flows) if (at >= flow.expiresAt) this.flows.delete(key)
    for (const [key, held] of this.settled) if (at >= held.expiresAt) this.settled.delete(key)
    for (const [key, held] of this.tickets) if (at >= held.expiresAt) this.tickets.delete(key)
    for (const [key, flow] of this.devices) if (at >= flow.expiresAt) this.devices.delete(key)
  }
}
