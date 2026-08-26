import type { ServedResponse } from './served-endpoints'
import type { ServedTemplate } from './session-served'

export interface ServedCheckoutInput {
  serviceId: string
  sub: string
  slug: string
  amountUsd: string
  successUrl: string
}

export interface ServedPayRouteDeps {
  issuer: {
    challenge(binding: string): string
    verifyToken(token: string): { sub: string; workspace: string } | null
  }
  /** Null is the normal no-key state: the Stripe rail is not advertised. */
  createCheckout: ((input: ServedCheckoutInput) => Promise<string | null>) | null
  successUrl(template: ServedTemplate): string
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
 */
export async function handleServedPayRoute(
  deps: ServedPayRouteDeps,
  template: ServedTemplate,
  method: string,
  pathname: string,
  headers: Record<string, string | undefined>
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
        successUrl: deps.successUrl(template)
      })
    )
    return url === null
      ? json(503, { error: 'card payment is not available right now' })
      : json(200, { url })
  } catch {
    return json(503, { error: 'card payment is not available right now' })
  }
}
