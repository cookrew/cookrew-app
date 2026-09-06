import { trustedNetwork, type TrustedNetwork } from '../../../shared/trusted-origin'
import type { DataPlane, DataPlaneKind } from '../data-plane'
import type { LocalNetworkState } from '../local-network'
import type { HelloReply, ReachCardLite } from './switch'

/**
 * THE SWITCH THAT DOES NOT NAVIGATE.
 *
 * switch.ts moves a companion onto a nearer path by loading the app at the
 * Mac's own address. Under the relay base that is forbidden and always will be
 * (companion-relay-no-jump.test.ts): the address bar is the account's origin,
 * the URL is the one thing Reach v2.1 promises never changes, and leaving it
 * mid-session is how the owner's phone ended up on a certificate warning
 * holding a pairing token.
 *
 * So the same decision is made and a different thing is done with it: the DATA
 * PLANE moves and the page stays. Every rule from switch.ts survives, and two
 * are added because the ground is different:
 *
 *   ONLY A TRUSTED NAME. The candidates are `card.trusted` and nothing else.
 *   The bare-IP addresses in `lan`/`tailnet` cannot be opened from a page on
 *   cookrew.dev — no public CA vouches for them — so racing them would spend a
 *   phone's battery producing a certificate error the reader never sees.
 *
 *   THE MAC PROVES ITSELF TO THE REGISTRY, NOT TO US. Navigating, the browser
 *   did half the work: it would not have loaded the page at all if the Mac's
 *   certificate were wrong. Here every trusted name is signed by the same
 *   public CA, so a device id and an echoed nonce prove only that SOMETHING
 *   under `d.cookrew.dev` answered. The signature over the nonce is checked by
 *   cookrew.dev, which is the only party holding the device's public key, and
 *   a plane is adopted only after it says yes.
 *
 * Pure and injected, like switch.ts, because these are the rules that get
 * broken quietly: a plane pointed at the wrong machine does not throw, it
 * sends the pairing token there.
 */

export interface PlaneCandidate {
  readonly origin: string
  readonly kind: TrustedNetwork
}

export type PlaneOutcome =
  /** Already on the best plane there is. */
  | 'skipped'
  /** The desktop could not be asked where else it lives. */
  | 'no-card'
  /** The Mac holds no trusted names, or none better than the current plane. */
  | 'no-trusted'
  /** Trusted names exist and none of them proved to be this Mac. */
  | 'unreachable'
  /** The browser refuses this page the local network. Nothing was tried. */
  | 'refused'
  /** The browser would prompt, and nobody is looking. Nothing was tried. */
  | 'unasked'
  | 'switched'

/** LAN beats tailnet beats relay, as everywhere else. */
export const planeRank = (kind: DataPlaneKind): number =>
  kind === 'lan' ? 3 : kind === 'tailnet' ? 2 : 1

/**
 * The trusted origins worth racing, best first, LAN before tailnet.
 *
 * Order is the whole value here — the race stops at the first origin that
 * proves itself, so a tailnet name ahead of a LAN name would settle a phone
 * standing in the house onto the long way round and then never look again
 * (only-better means the tailnet plane is not an improvement on itself).
 */
export const planeCandidates = (
  card: ReachCardLite,
  current: DataPlaneKind
): readonly PlaneCandidate[] => {
  const here = planeRank(current)
  const seen = new Set<string>()
  const candidates: PlaneCandidate[] = []
  for (const origin of card.trusted ?? []) {
    if (typeof origin !== 'string') continue
    const trimmed = origin.replace(/\/+$/, '')
    if (seen.has(trimmed)) continue
    const kind = trustedNetwork(trimmed)
    if (kind === null || planeRank(kind) <= here) continue
    seen.add(trimmed)
    candidates.push({ origin: trimmed, kind })
  }
  return [
    ...candidates.filter((candidate) => candidate.kind === 'lan'),
    ...candidates.filter((candidate) => candidate.kind === 'tailnet')
  ]
}

/** What the registry is asked, and what it answers: one bit. */
export interface HelloClaim {
  readonly deviceId: string
  readonly nonce: string
  readonly sig: string
}

export interface PlaneSwitchDeps {
  readonly plane: () => DataPlane
  /** `GET /api/reach` over whatever plane is already working. */
  readonly card: () => Promise<ReachCardLite | null>
  /** `GET <origin>/api/hello?nonce=`, with a short deadline. Null = no answer. */
  readonly hello: (origin: string, nonce: string) => Promise<HelloReply | null>
  /** `POST /v2/verify-hello` at the registry. False on anything but a yes. */
  readonly verify: (claim: HelloClaim) => Promise<boolean>
  /** Move the plane. NEVER a navigation — that is the point of this module. */
  readonly adopt: (plane: DataPlane) => void
  readonly nonce: () => string
  /** True while the switcher is holding off after a direct plane failed. */
  readonly held?: () => boolean
  readonly probing?: (on: boolean) => void
  /**
   * What the browser will do about the local network, read fresh per race.
   *
   * Absent means the question cannot be asked here, which is treated exactly
   * as 'unsupported': race, and let the request answer.
   */
  readonly permission?: () => Promise<LocalNetworkState>
  /**
   * MAY THIS RACE RAISE A PERMISSION PROMPT? False for every race the clock
   * started; true only for the one a person pressed.
   */
  readonly mayPrompt?: () => boolean
}

/**
 * THE PERMISSION POLICY, as one rule with the four states side by side.
 *
 *   denied      — do not race. Every probe would be blocked, and a blocked
 *                 probe is indistinguishable from a sleeping Mac, so racing
 *                 would spend battery AND make the "why this path" panel lie.
 *   prompt      — race only when a person asked. Chrome raises the dialog from
 *                 the request itself; a race off the 60-second timer therefore
 *                 puts a dialog in front of a phone in a pocket, and an unseen
 *                 dialog is dismissed — which is a refusal that then persists.
 *   granted     — race.
 *   unsupported — race. Safari today: a browser that never prompts either
 *                 allows the request or fails it, and a failed request is
 *                 already "not this path".
 */
export const mayRace = (state: LocalNetworkState, mayPrompt: boolean): boolean =>
  state === 'denied' ? false : state === 'prompt' ? mayPrompt : true

/**
 * One race. Returns what happened, so a caller can log it and a test can read
 * it — nothing here throws, because this runs on a timer nobody is watching.
 */
export const switchPlaneIfBetter = async (deps: PlaneSwitchDeps): Promise<PlaneOutcome> => {
  const current = deps.plane()
  if (planeRank(current.kind) >= planeRank('lan')) return 'skipped'
  // A plane that just died is not a plane to re-adopt this minute. Without the
  // hold, a Mac that answers hello but cannot carry the session would be
  // adopted, dropped, and adopted again forever — a flap the reader sees as a
  // badge blinking between LAN and RELAY.
  if (deps.held?.() === true) return 'skipped'
  // AFTER the cheap local answers and BEFORE any request. A phone already on
  // the LAN, or holding off after a fallback, has no permission question to
  // ask; a phone that has been refused must not even fetch the card, because
  // nothing on it could be used.
  const permission = await deps.permission?.().catch((): LocalNetworkState => 'unsupported')
  if (permission !== undefined && !mayRace(permission, deps.mayPrompt?.() === true)) {
    return permission === 'denied' ? 'refused' : 'unasked'
  }
  const card = await deps.card().catch(() => null)
  if (!card || card.deviceId.length === 0) return 'no-card'
  const candidates = planeCandidates(card, current.kind)
  if (candidates.length === 0) return 'no-trusted'

  deps.probing?.(true)
  try {
    for (const candidate of candidates) {
      const nonce = deps.nonce()
      const reply = await deps.hello(candidate.origin, nonce).catch(() => null)
      // The device id says it is the right Mac and the echoed nonce says the
      // answer was made just now — both cheap, both checked here so a wrong
      // one never costs the registry a request.
      if (!reply || reply.deviceId !== card.deviceId || reply.nonce !== nonce) continue
      if (typeof reply.sig !== 'string' || reply.sig.length === 0) continue
      const proved = await deps
        .verify({ deviceId: card.deviceId, nonce, sig: reply.sig })
        .catch(() => false)
      if (!proved) continue
      deps.adopt({ origin: candidate.origin, kind: candidate.kind })
      return 'switched'
    }
    return 'unreachable'
  } finally {
    deps.probing?.(false)
  }
}

/**
 * How often a companion under the base looks for a faster plane.
 *
 * Slower than the navigating switcher's 30 s because the cost profile is
 * inverted: that one is racing to end a page load, this one is racing to
 * improve a session that is already working, and every race is a fetch plus
 * one probe per trusted name off a phone battery.
 */
export const PLANE_PROBE_EVERY_MS = 60_000
