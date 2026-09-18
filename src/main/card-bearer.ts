import { timingSafeEqual } from 'node:crypto'

/**
 * THE CARD ASKS THE APP WHO IT IS AT A DOOR (v3, G1 — the third caller).
 *
 * V3-04 made the import walk sign in as the ACCOUNT at a listed door, and
 * V3-04b brought the two calls that FOLLOW an import — the transcript reads
 * and END — onto the same credential. The third caller is the card's own line:
 * `resources/orch-line.mjs` runs in the card's PTY as a separate node process,
 * and it was still performing the v1 challenge ceremony with a per-door key.
 * So a listed door heard TWO callers for one card, and at a paid door the seat
 * bought on the web could not admit the line at all — the key-holder sub is
 * not the person the seat names.
 *
 * WHY THE CARD ASKS RATHER THAN MINTING. A call token is minted with this
 * Mac's cookrew.dev SESSION, which is the account itself — thirty days of full
 * authority. The card is a window onto a stranger's team; putting the session
 * where that process can read it would trade the whole account for one door.
 * So the card asks, and the app answers with a credential for ONE door.
 *
 * WHY IT ASKS EVERY TIME rather than reading a token the app leaves out for
 * it. A call token lives ten minutes and a card lives for hours, so a file
 * would have to be kept fresh by a timer minting tokens nobody spends, and
 * would still race the moment a card reconnects. Asking is fresh by
 * construction, leaves no door credential at rest, and survives an app restart
 * with the machinery the card already has — it re-reads the same file for the
 * relay port after every restart, and now reads the shared secret beside it.
 *
 * WHAT COMES BACK IS THE DOOR'S OWN BEARER, not the cookrew.dev call token.
 * The app does the whole walk through `doorBearer`, the same function the
 * transcript and END use, so all three callers are one code path and one
 * decision about listed-versus-direct. The card is handed the narrower of the
 * two credentials — one door, one hour — and the account's token never enters
 * its process at all.
 *
 * AN UNLISTED DOOR IS NOT ASKED ABOUT. It has no published name, so there is
 * nothing for cookrew.dev to mint against; the card signs in with its own key,
 * which is the DIRECT walk and is correct. The card never decides this — it
 * asks whenever it was given a door name, and `doorBearer` applies the rule.
 */

/** The one path. It cannot collide with a door: every door name begins `@`. */
export const CARD_BEARER_PATH = '/bearer'

/** `@handle/team`, as the registry writes it and the card validates it. */
const DOOR_NAME = /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export interface CardBearerDeps {
  /**
   * The shared secret the app wrote beside the port, in a file only this user
   * can read. Null before the proxy has minted one, which refuses everything.
   */
  secret: () => string | null
  /** The whole walk for one door: `doorBearer`, as the other two callers use. */
  bearer: (door: string) => Promise<string>
  /** Who this Mac is signed in as, so the card can say it. Null when nobody. */
  account: () => string | null
}

export interface CardBearerRequest {
  method: string
  path: string
  /** The `authorization` header, verbatim. */
  authorization?: string | undefined
  /**
   * The `origin` header, when there was one. A CARD NEVER SENDS ONE: it is a
   * node process, not a browser. A request that does carry one was caused by a
   * page — which cannot hold the secret and could not read the answer anyway,
   * but "a request another site caused is not this person's wish" is the rule
   * the rest of this codebase keeps, and it costs one line to keep it here.
   */
  origin?: string | undefined
  /** The parsed body, or null when it was not JSON. */
  body: unknown
}

export interface CardBearerAnswer {
  status: number
  body: Record<string, unknown>
}

/** Is this the bearer route at all? Anything else belongs to the proxy. */
export const isCardBearerRequest = (method: string, path: string): boolean =>
  method === 'POST' && path === CARD_BEARER_PATH

/**
 * Same length, then constant time.
 *
 * A length check is not a leak worth avoiding here — the secret is a fixed
 * width this process chose — and `timingSafeEqual` throws on a mismatch, which
 * would turn a wrong guess into a 500 instead of a 401.
 */
const holds = (offered: string, secret: string): boolean => {
  const a = Buffer.from(offered, 'utf8')
  const b = Buffer.from(secret, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Answer one ask.
 *
 * EVERY REFUSAL IS THE SAME SHAPE and names itself, because the card prints
 * what comes back: a person whose card will not open is owed the difference
 * between "Cookrew is not signed in", "you have no seat here" and "this door
 * refused the token", and those are three different things to do next.
 */
export async function cardBearerAnswer(
  deps: CardBearerDeps,
  request: CardBearerRequest
): Promise<CardBearerAnswer> {
  // A BROWSER ASKED, WHICH NOBODY MEANT TO DO. Refused before the guard is
  // even consulted, so a page cannot use the timing of a refusal to learn
  // anything about the secret either.
  if (typeof request.origin === 'string' && request.origin.length > 0) {
    return { status: 401, body: { error: 'not-this-mac' } }
  }
  const secret = deps.secret()
  const header = request.authorization ?? ''
  const offered = header.startsWith('Bearer ') ? header.slice(7) : ''
  // ONE 401 FOR EVERY WAY OF NOT HOLDING IT. A caller must not be able to
  // learn whether the app has minted a secret yet by the shape of the refusal.
  if (secret === null || offered.length === 0 || !holds(offered, secret)) {
    return { status: 401, body: { error: 'not-this-mac' } }
  }
  const asked = typeof request.body === 'object' && request.body !== null ? request.body : {}
  const door = (asked as { door?: unknown }).door
  if (typeof door !== 'string' || !DOOR_NAME.test(door)) {
    return { status: 400, body: { error: 'bad-door' } }
  }
  try {
    const token = await deps.bearer(door)
    const account = deps.account()
    return { status: 200, body: { token, ...(account === null ? {} : { account }) } }
  } catch (error) {
    // The message carries the phase `doorBearer` named — no account, no seat,
    // or a door that refused the minted token.
    return {
      status: 403,
      body: { error: 'refused', message: error instanceof Error ? error.message : String(error) }
    }
  }
}
