import { readHelloReply } from '../../../shared/hello-proof'
import { trustedNetwork, type TrustedNetwork } from '../../../shared/trusted-origin'
import type { DataPlane, DataPlaneKind } from '../data-plane'
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

/** What the registry is asked, and what it answers: one bit and a reason. */
export interface HelloClaim {
  readonly deviceId: string
  readonly nonce: string
  readonly sig: string
  /** HELLO v2: the endpoint the Mac signed, and its clock when it signed. */
  readonly origin: string
  readonly issuedAtMs: number
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
}

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
  const card = await deps.card().catch(() => null)
  if (!card || card.deviceId.length === 0) return 'no-card'
  const candidates = planeCandidates(card, current.kind)
  if (candidates.length === 0) return 'no-trusted'

  deps.probing?.(true)
  try {
    for (const candidate of candidates) {
      const nonce = deps.nonce()
      const reply = await deps.hello(candidate.origin, nonce).catch(() => null)
      // Everything checkable without the registry, checked here so a wrong
      // answer never costs it a request — INCLUDING THE ONE THAT MATTERS: a
      // signature naming a different origin is our own challenge relayed to
      // the real Mac by whatever answered here. src/shared/hello-proof.ts.
      const read = readHelloReply(reply, {
        origin: candidate.origin,
        deviceId: card.deviceId,
        nonce
      })
      if (!read.ok) continue
      const proved = await deps
        .verify({ deviceId: card.deviceId, nonce, ...read.proof })
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
