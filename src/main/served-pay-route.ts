import type { ServedResponse } from './served-endpoints'
import type { ServedTemplate } from './session-served'

export interface ServedCheckoutInput {
  serviceId: string
  sub: string
  slug: string
  amountUsd: string
  /** The door's own face, `?payment=received` — used when no return page was asked for. */
  successUrl: string
  /**
   * The team's page at cookrew.dev, when the caller is paying FROM that page.
   * Already validated (see `returnUrlFor`): Stripe sends the buyer back here
   * with the session id, and the page opens the line by itself.
   */
  returnUrl?: string
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
  /** Where cookrew.dev — or whatever stands in for it — is. */
  registryOrigin?(): string
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
 * WHERE A BUYER MAY BE SENT BACK TO, and nowhere else.
 *
 * A caller names the page it is paying from, and Stripe redirects there with
 * the session id in the query. Left open, that is a redirect to anywhere a
 * caller likes with a `cs_` id attached — so the page has to be OURS: the
 * registry's own origin, and exactly this door's published page under it,
 * `/<handle>/<team>` with nothing else on it. A door with no published name
 * has no such page and takes no return at all.
 *
 * Returns the canonical page URL, or null for anything that is not it.
 */
export function returnUrlFor(registryOrigin: string, doorName: string | null, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || doorName === null) return null
  let origin: URL
  let url: URL
  try {
    origin = new URL(registryOrigin)
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== origin.origin) return null
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null
  const page = `/${doorName.replace(/^@/, '')}`
  if (url.pathname !== page) return null
  return `${url.origin}${page}`
}

/**
 * Stripe Checkout session creation beside the gate, never inside it.
 *
 * The gate still touches payments only through paymentTerms + settle. This is
 * a caller convenience endpoint that turns an authenticated quote into a
 * hosted Checkout URL; admission still happens only when /ask settles it.
 *
 * The body is optional: `{ returnUrl }` names the team's page at cookrew.dev
 * so the buyer lands back on it with the session id and the page opens the
 * line itself. A body that names anywhere else is refused outright rather
 * than quietly replaced — a caller that asked for a return and got the door's
 * own face instead would be left on a page with no line to open.
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

  const team = deps.doorName?.(template) ?? null
  const asked = (body as { returnUrl?: unknown } | null)?.returnUrl
  const returnUrl =
    asked === undefined ? null : returnUrlFor(deps.registryOrigin?.() ?? '', team, asked)
  if (asked !== undefined && returnUrl === null) return json(400, { error: 'bad_return' })

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
        ...(returnUrl === null ? {} : { returnUrl }),
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
