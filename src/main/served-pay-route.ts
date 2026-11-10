import type { ServedResponse } from './served-endpoints'
import type { ServedTemplate } from './session-served'

export interface ServedCheckoutInput {
  serviceId: string
  sub: string
  slug: string
  amountUsd: string
  /** The door's own face, `?payment=received` — the one place Stripe sends a buyer back to. */
  successUrl: string
  /** `@handle/team`, for the words on the receipt; absent at an unlisted door. */
  team?: string
}

export interface ServedPayRouteDeps {
  issuer: {
    challenge(binding: string): string
    verifyToken(token: string): { sub: string; workspace: string } | null
  }
  /** Null is the normal no-key state: the Stripe rail is not advertised. */
  createCheckout: ((input: ServedCheckoutInput) => Promise<string | null>) | null
  successUrl(template: ServedTemplate): string
  /** The door's published `@handle/team`, or null when it is not on the relay. */
  doorName?(template: ServedTemplate): string | null
}

const json = (status: number, body: unknown, headers?: Record<string, string>): ServedResponse =>
  headers ? { status, headers, body } : { status, body }

function checkoutUrl(value: string | null): string | null {
  if (value === null) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Stripe Checkout session creation beside the gate, never inside it.
 *
 * The gate still touches payments only through paymentTerms + settle. This is
 * a caller convenience endpoint that turns an authenticated quote into a
 * hosted Checkout URL; admission still happens only when /ask settles it.
 *
 * THE ROUTE TAKES NO BODY. The app sends none: it opens the hosted page for
 * the buyer and reads the session id off the URL this route returns
 * (served-admission.ts startStripeCheckout). Until 0.6.0 a `{ returnUrl }`
 * named the team's page at cookrew.dev, and Stripe sent the buyer back there
 * with the session id; those pages are gone, and with them the only caller.
 * A body that still names a return is REFUSED rather than ignored — a caller
 * that asked to be sent back and was not would have paid and landed on the
 * door's face, with nothing there to open the line it paid for.
 */
export async function handleServedPayRoute(
  deps: ServedPayRouteDeps,
  template: ServedTemplate,
  method: string,
  pathname: string,
  headers: Record<string, string | undefined>,
  body: unknown = null
): Promise<ServedResponse | null> {
  if (method !== 'POST' || pathname !== '/api/call/pay') return null
  if (template.access !== 'paid' || template.priceUsd === undefined) return json(404, {})

  const auth = headers.authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const claims = token === null ? null : deps.issuer.verifyToken(token)
  if (claims === null) {
    return json(401, {}, {
      'www-authenticate': `Cookrew realm="${template.slug}", challenge=${deps.issuer.challenge(template.serviceId)}`
    })
  }
  if (claims.workspace !== template.serviceId) return json(403, { reason: 'workspace' })

  if (typeof body === 'object' && body !== null && 'returnUrl' in body) {
    return json(400, { error: 'bad_return' })
  }
  const team = deps.doorName?.(template) ?? null

  if (deps.createCheckout === null) {
    return json(503, { error: 'card payment is not available right now' })
  }

  try {
    const url = checkoutUrl(
      await deps.createCheckout({
        serviceId: template.serviceId,
        sub: claims.sub,
        slug: template.slug,
        amountUsd: template.priceUsd,
        successUrl: deps.successUrl(template),
        ...(team === null ? {} : { team })
      })
    )
    return url === null
      ? json(503, { error: 'card payment is not available right now' })
      : json(200, { url })
  } catch {
    return json(503, { error: 'card payment is not available right now' })
  }
}
