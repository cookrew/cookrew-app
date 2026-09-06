import { classifyOrigin, type PathState } from '../../../shared/path-badge'

/**
 * LIVE PATH SWITCHING — the phone walks in the door and the session follows.
 *
 * "When the phone joins the LAN the session switches live and the badge flips
 * to ● LAN; nothing to confirm." That sentence is the whole feature, and every
 * decision here comes out of it:
 *
 *   THE SESSION IS KEYED BY DEVICE, NEVER BY PATH. Switching is a navigation
 *   to the same app at a different address carrying the same credential — the
 *   one the companion already holds. Nothing is re-paired, nothing is
 *   re-admitted, and the transcript on the other side is the same transcript.
 *
 *   NOBODY IS ASKED. A prompt would arrive when the phone was in a pocket, and
 *   the honest answer to "do you want the fast path" is always yes. The badge
 *   reads PROBING while the race runs and the new word after it; that is the
 *   entire notification.
 *
 *   ONLY BETTER, NEVER SIDEWAYS. LAN over tailnet over relay, and a switch is
 *   attempted only DOWN that list. Without it a phone on the tailnet would
 *   flip to the relay and back forever, and each flip is a page load.
 *
 *   AN ADDRESS THAT ANSWERS IS NOT THE MAC. Something else on the Wi-Fi
 *   answers on port 8643 too; a captive portal answers everything. So the
 *   candidate must say the device id the desktop just named, over a nonce it
 *   cannot have seen — the same `/api/hello` the registry's picker uses.
 *
 * WHY THE PROBE IS THE COMPANION'S AND NOT THE REGISTRY'S: the registry can
 * only tell the phone where the Mac SAYS it is. Whether this phone, on this
 * network, this minute, can actually reach it is a fact only this phone can
 * establish, and only by trying.
 */

/** One address off the desktop's own reach card. */
export interface ReachAddressLite {
  readonly url: string
  readonly certFp?: string
}

/** What `GET /api/reach` answers: this Mac's direct addresses. */
export interface ReachCardLite {
  readonly deviceId: string
  readonly lan: readonly ReachAddressLite[]
  readonly tailnet: ReachAddressLite | null
  /**
   * THE ORIGINS A PAGE UNDER THE RELAY BASE IS ALLOWED TO TRY (Reach v2.1).
   *
   * `lan` and `tailnet` are bare-IP URLs. They are perfectly good for a page
   * that is already off cookrew.dev and about to navigate, and they are
   * USELESS to a page that must not navigate: opening one from cookrew.dev
   * gets a certificate warning or a silent failure, because no public CA will
   * ever vouch for `https://192.168.2.40:8643`.
   *
   * `trusted` holds the same addresses under names the Mac holds a real
   * certificate for — `https://192-168-2-40.<id>.d.cookrew.dev:8643` — and is
   * EMPTY when it holds none (no account, no internet, issuance not done). An
   * empty list is the honest answer and it simply means no live switch today,
   * never a fall back to a bare IP.
   */
  readonly trusted?: readonly string[]
}

export interface Candidate {
  readonly url: string
  readonly state: 'LAN' | 'TAILNET'
}

export type SwitchOutcome =
  /** Already on the best path there is. */
  | 'skipped'
  /** The desktop could not be asked where else it lives. */
  | 'no-card'
  /** Nothing on the card beats where this phone already is. */
  | 'no-better'
  /** Better addresses exist and none of them answered as this Mac. */
  | 'unreachable'
  /** A switch would land unpaired, so it is not made. */
  | 'no-credential'
  | 'switched'

/** LAN beats tailnet beats relay. Anything unknown is worse than all of them. */
export const pathRank = (state: PathState): number =>
  state === 'LAN' ? 3 : state === 'TAILNET' ? 2 : state === 'RELAY' ? 1 : 0

export const PATH_MEMORY_PREFIX = 'cr_path:'

/** Every candidate strictly better than where the phone is, best first. */
export const betterCandidates = (
  card: ReachCardLite,
  current: PathState,
  remembered?: string | null
): readonly Candidate[] => {
  const here = pathRank(current)
  const all: Candidate[] = [
    ...card.lan.map((address): Candidate => ({ url: address.url, state: 'LAN' })),
    ...(card.tailnet ? [{ url: card.tailnet.url, state: 'TAILNET' } as Candidate] : [])
  ]
  const better = all.filter((candidate) => pathRank(candidate.state) > here)
  // The address that worked last time on this network goes first. It is a
  // hint and never a decision: it is still asked to prove it is the Mac.
  const won = better.filter((candidate) => candidate.url === remembered)
  return [...won, ...better.filter((candidate) => candidate.url !== remembered)]
}

/** What a candidate must say to be believed. */
export interface HelloReply {
  readonly deviceId?: string
  readonly nonce?: string
  /**
   * The device's signature over the challenge, checked by the REGISTRY.
   *
   * Unused by the navigating switch, which is judged sufficient by the device
   * id and the echoed nonce: it runs on a page already served by the Mac, so
   * the candidate has already presented a certificate this browser accepted.
   * A page under the relay base has no such proof — every trusted name is
   * signed by the same public CA — so `/v2/verify-hello` is the gate there.
   */
  readonly sig?: string
}

export interface SwitchDeps {
  /** Where the phone is now, from its own origin. */
  readonly current: () => PathState
  /** `GET /api/reach` on whatever path is already working. */
  readonly card: () => Promise<ReachCardLite | null>
  /** `GET <candidate>/api/hello?nonce=`, with a short deadline. Null = no answer. */
  readonly hello: (url: string, nonce: string) => Promise<HelloReply | null>
  /** The credential the companion already holds; it travels to the new address. */
  readonly credential: () => string | null
  readonly go: (url: string) => void
  readonly nonce: () => string
  readonly remembered?: (deviceId: string) => string | null
  readonly remember?: (deviceId: string, url: string) => void
  readonly probing?: (on: boolean) => void
}

/**
 * One race. Returns what happened, so a caller can log it and a test can read
 * it — nothing here throws, because this runs on a timer nobody is watching.
 */
export const switchIfBetter = async (deps: SwitchDeps): Promise<SwitchOutcome> => {
  const current = deps.current()
  if (pathRank(current) >= pathRank('LAN')) return 'skipped'
  const card = await deps.card().catch(() => null)
  if (!card || card.deviceId.length === 0) return 'no-card'
  const candidates = betterCandidates(card, current, deps.remembered?.(card.deviceId) ?? null)
  if (candidates.length === 0) return 'no-better'

  deps.probing?.(true)
  try {
    for (const candidate of candidates) {
      const nonce = deps.nonce()
      const reply = await deps.hello(candidate.url, nonce).catch(() => null)
      // BOTH, and both matter: the device id says it is the right Mac, the
      // echoed nonce says the answer was made just now rather than replayed.
      if (!reply || reply.deviceId !== card.deviceId || reply.nonce !== nonce) continue
      const credential = deps.credential()
      // A switch without the credential would land on a re-pair screen, which
      // is strictly worse than the slow path that is working.
      if (!credential) return 'no-credential'
      deps.remember?.(card.deviceId, candidate.url)
      // The legacy admission: the companion's boot lifts `?token=` into
      // storage and scrubs it from the address bar. Reusing it is deliberate
      // — a second way to carry the session would be a second thing to revoke.
      deps.go(`${candidate.url}/?token=${encodeURIComponent(credential)}`)
      return 'switched'
    }
    return 'unreachable'
  } finally {
    // Left on only when the page is already leaving, so the badge does not
    // blink back to the old word during the navigation.
    deps.probing?.(false)
  }
}

// ── the browser wiring ────────────────────────────────────────────────────

/** How often a companion on a slow path looks for a faster one. */
export const PROBE_EVERY_MS = 30_000

/**
 * How long a candidate has to answer.
 *
 * It is on the same Wi-Fi or it is not; an address that needs longer than this
 * is not the fast path this is looking for, and a phone must not stall on a
 * black hole while the working path sits idle.
 */
export const HELLO_TIMEOUT_MS = 800

/** 16 random bytes, base64url — what `/api/hello` accepts. */
export const randomNonce = (random: (bytes: Uint8Array) => Uint8Array): string => {
  const bytes = random(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** One `fetch` with a deadline, answering null rather than throwing. */
export const askHello = async (
  url: string,
  nonce: string,
  timeoutMs = HELLO_TIMEOUT_MS
): Promise<HelloReply | null> => {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetch(`${url}/api/hello?nonce=${encodeURIComponent(nonce)}`, {
      signal: abort.signal,
      // No cookies and no credentials: the answer is a public fact about the
      // Mac, and sending anything else to an address that has not yet proved
      // it IS the Mac would be sending it to whatever answered.
      credentials: 'omit',
      cache: 'no-store'
    })
    if (!response.ok) return null
    return (await response.json()) as HelloReply
  } catch {
    // A refused certificate, a timeout, a network that is not there. All of
    // them mean the same thing here: not this address, not now.
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface RaceLoopOptions {
  /** One race. Never rejects; the loop drops a rejection anyway. */
  readonly race: () => Promise<unknown>
  readonly everyMs?: number
  /** window, or a stand-in with the three listeners this uses. */
  readonly on?: (event: string, listener: () => void) => () => void
  readonly setInterval?: (fn: () => void, ms: number) => () => void
}

/**
 * Run a race on a timer, and whenever the network might just have changed.
 *
 * `online` and `visibilitychange` are the two moments that matter and neither
 * is covered by a 30-second clock: a phone taken out of a pocket inside the
 * house is on the LAN the instant its screen wakes, and waiting half a minute
 * to notice is the difference between "it just works" and "it eventually works".
 *
 * Shared by both switchers — the navigating one below and the data-plane one
 * in plane-switch.ts. The schedule and the ONE-AT-A-TIME rule are the same
 * problem in both, and a second copy is a second place for a phone to end up
 * running three probes every time it wakes.
 */
export const startRaceLoop = (options: RaceLoopOptions): (() => void) => {
  let running = false

  const race = (): void => {
    // One at a time: three events can land together when a phone wakes up on
    // a new network, and three simultaneous races would triple the probes and
    // could navigate twice.
    if (running) return
    running = true
    void options
      .race()
      .catch(() => undefined)
      .finally(() => void (running = false))
  }

  const every = options.setInterval ?? ((fn, ms) => {
    const handle = setInterval(fn, ms)
    return () => clearInterval(handle)
  })
  const listen =
    options.on ??
    ((event, listener) => {
      window.addEventListener(event, listener)
      return () => window.removeEventListener(event, listener)
    })

  const offs: (() => void)[] = [
    every(race, options.everyMs ?? PROBE_EVERY_MS),
    listen('online', race),
    listen('visibilitychange', race)
  ]
  race()
  return () => offs.forEach((off) => off())
}

export interface PathSwitchOptions {
  readonly deps: SwitchDeps
  readonly everyMs?: number
  /** window, or a stand-in with the three listeners this uses. */
  readonly on?: (event: string, listener: () => void) => () => void
  readonly setInterval?: (fn: () => void, ms: number) => () => void
  readonly log?: (message: string) => void
}

/** The navigating switch, on the loop. Root-served companions only. */
export const startPathSwitching = (options: PathSwitchOptions): (() => void) => {
  const log = options.log ?? ((): void => undefined)
  return startRaceLoop({
    ...(options.everyMs !== undefined ? { everyMs: options.everyMs } : {}),
    ...(options.on ? { on: options.on } : {}),
    ...(options.setInterval ? { setInterval: options.setInterval } : {}),
    race: () =>
      switchIfBetter(options.deps).then((outcome) => {
        if (outcome === 'switched' || outcome === 'unreachable') log(`path switch: ${outcome}`)
        return outcome
      })
  })
}

/** Where this page is, as the badge reads it. */
export const originState = (origin: string, registryOrigin?: string): PathState =>
  registryOrigin ? classifyOrigin(origin, registryOrigin) : classifyOrigin(origin)
