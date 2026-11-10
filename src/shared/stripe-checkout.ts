/**
 * STRIPE'S HOSTED CHECKOUT — the two facts every side of a card payment
 * shares: what its page's address looks like, and how long a session lives.
 *
 * Pure, and in `shared` because three places need the same answer and must
 * not each have their own: the door (which creates the session and hands the
 * address out), the caller's main process (which reads the address a DOOR
 * sent and opens it in the real browser), and the renderer (the phone opens
 * it in a tab; the sheet waits on the session for as long as it can be paid).
 */

/**
 * One quote window, in seconds. The door creates a session whose `expires_at`
 * is the end of the NEXT window (stripe-rail.ts), so every retry inside one
 * window is byte-identical and replays the same session.
 */
export const CHECKOUT_TTL_SECONDS = 30 * 60

/**
 * The longest a session can still be paid: it expires at the end of the next
 * window, which is between one and two windows away. Anything that waits on a
 * card payment waits this long, or it gives up while the page still takes money.
 */
export const CHECKOUT_MAX_LIFE_SECONDS = 2 * CHECKOUT_TTL_SECONDS

const CHECKOUT_HOST = 'checkout.stripe.com'

/**
 * Is this address Stripe's hosted Checkout, and nothing dressed as it?
 *
 * https, the host exactly, no credentials, no port. The address is opened —
 * by `shell.openExternal`, which launches whatever handles the scheme, and by
 * `window.open` — and it arrives from a door the caller has no reason to
 * trust, so "contains the right words" is not a check: `file:///…#/cs_x`
 * contains a session id, and `https://checkout.stripe.com@evil.example/`
 * contains the host.
 */
export function isStripeCheckoutUrl(raw: unknown): raw is string {
  // Not trimmed: an address that needs cleaning up was not written by Stripe.
  if (typeof raw !== 'string' || raw.trim() !== raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === CHECKOUT_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

/**
 * The session id in a Checkout address, read from its PATH — the one part
 * Stripe writes it in. A fragment or a query is where a door would put a
 * string that only looks like one.
 */
export function checkoutSessionOf(raw: unknown): string | null {
  if (!isStripeCheckoutUrl(raw)) return null
  return /\/(cs_[A-Za-z0-9_]+)/.exec(new URL(raw).pathname)?.[1] ?? null
}
