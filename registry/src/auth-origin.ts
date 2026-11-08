/**
 * AUTH_ORIGIN, CHECKED BEFORE ANYTHING IS SERVED.
 *
 * The auth origin is a different host from the product origin, and a
 * subdomain of it: a passkey made on cookrew.dev carries rpId `cookrew.dev`,
 * and WebAuthn only lets auth.cookrew.dev ask for it because cookrew.dev is a
 * registrable suffix of its host. Plain http only on loopback names (a dev
 * registry on `auth.localhost`), and never a path, query or credentials.
 */

const LOOPBACK = (hostname: string): boolean =>
  hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]'

/** The serialised auth origin, or a sentence saying why it cannot be one. */
export function readAuthOrigin(raw: string | undefined, productOrigin: string): { ok: true; origin: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, origin: null }
  let auth: URL
  let product: URL
  try {
    auth = new URL(raw.trim())
    product = new URL(productOrigin)
  } catch {
    return { ok: false, reason: `AUTH_ORIGIN ${raw} is not a URL` }
  }
  const origin = auth.origin
  if (raw.trim().replace(/\/$/, '') !== origin || auth.username !== '' || auth.password !== '') {
    return { ok: false, reason: `AUTH_ORIGIN ${raw} must be an origin alone, like https://auth.cookrew.dev` }
  }
  if (auth.protocol !== 'https:' && !(auth.protocol === 'http:' && LOOPBACK(auth.hostname))) {
    return { ok: false, reason: `AUTH_ORIGIN ${raw} must be https (http only on a loopback name)` }
  }
  if (auth.host === product.host) return { ok: false, reason: 'AUTH_ORIGIN must be a different host from the product origin' }
  if (!auth.hostname.endsWith(`.${product.hostname}`)) {
    return { ok: false, reason: `AUTH_ORIGIN must be a subdomain of ${product.hostname}, so its passkeys open both` }
  }
  return { ok: true, origin }
}
