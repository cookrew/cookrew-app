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

/** One named origin of ours, or a sentence saying why it cannot be one. `name` is the variable it was read from. */
function readSubOrigin(
  name: string,
  example: string,
  raw: string | undefined,
  productOrigin: string
): { ok: true; origin: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, origin: null }
  let own: URL
  let product: URL
  try {
    own = new URL(raw.trim())
    product = new URL(productOrigin)
  } catch {
    return { ok: false, reason: `${name} ${raw} is not a URL` }
  }
  const origin = own.origin
  if (raw.trim().replace(/\/$/, '') !== origin || own.username !== '' || own.password !== '') {
    return { ok: false, reason: `${name} ${raw} must be an origin alone, like ${example}` }
  }
  if (own.protocol !== 'https:' && !(own.protocol === 'http:' && LOOPBACK(own.hostname))) {
    return { ok: false, reason: `${name} ${raw} must be https (http only on a loopback name)` }
  }
  if (own.host === product.host) return { ok: false, reason: `${name} must be a different host from the product origin` }
  if (!own.hostname.endsWith(`.${product.hostname}`)) {
    return { ok: false, reason: `${name} must be a subdomain of ${product.hostname}, so its passkeys open both` }
  }
  return { ok: true, origin }
}

/** The serialised auth origin, or a sentence saying why it cannot be one. */
export function readAuthOrigin(raw: string | undefined, productOrigin: string): { ok: true; origin: string | null } | { ok: false; reason: string } {
  return readSubOrigin('AUTH_ORIGIN', 'https://auth.cookrew.dev', raw, productOrigin)
}

export type HostOrigins =
  | { ok: true; auth: string | null; api: string | null; console: string | null }
  | { ok: false; reason: string }

/**
 * THE THREE ORIGINS A REGISTRY IS STARTED WITH (0.6.0), checked together.
 *
 *   AUTH_ORIGIN      the sign-in page, served by this process on its own host
 *   API_ORIGIN       /v1, /v2 and the relay path, on their own host (api-host.ts)
 *   CONSOLE_ORIGIN   the console, a static site hosted elsewhere: the one
 *                    origin a page may call the API from
 *
 * A REAL REGISTRY NEEDS ALL THREE, and refuses to start without them. One
 * host answering everything reads a session cookie on whatever name reaches
 * it, which is the arrangement the split exists to end; a deployment that
 * forgot a variable must not quietly run that way. `--dev` may be one host
 * (with or without the sign-in page), which is what a local binary and the
 * suites run. Half a split is refused either way: the API host without the
 * console lets no page call it, and the console is called from nowhere without
 * the API host.
 */
export function readHostOrigins(
  env: { AUTH_ORIGIN?: string; API_ORIGIN?: string; CONSOLE_ORIGIN?: string },
  productOrigin: string,
  options: { dev: boolean }
): HostOrigins {
  const auth = readSubOrigin('AUTH_ORIGIN', 'https://auth.cookrew.dev', env.AUTH_ORIGIN, productOrigin)
  if (!auth.ok) return auth
  const api = readSubOrigin('API_ORIGIN', 'https://api.cookrew.dev', env.API_ORIGIN, productOrigin)
  if (!api.ok) return api
  const console_ = readSubOrigin('CONSOLE_ORIGIN', 'https://console.cookrew.dev', env.CONSOLE_ORIGIN, productOrigin)
  if (!console_.ok) return console_
  const missing = [
    ...(auth.origin === null ? ['AUTH_ORIGIN'] : []),
    ...(api.origin === null ? ['API_ORIGIN'] : []),
    ...(console_.origin === null ? ['CONSOLE_ORIGIN'] : [])
  ]
  const split = api.origin !== null || console_.origin !== null
  if (missing.length > 0 && (split || !options.dev)) {
    return {
      ok: false,
      reason: split
        ? `${missing.join(' and ')} must be set too: the API host, the console and the sign-in page go together`
        : `${missing.join(', ')} must be set: this registry answers on its API and auth hosts (only --dev runs as one host)`
    }
  }
  const hosts = [auth.origin, api.origin, console_.origin].filter((origin): origin is string => origin !== null).map((origin) => new URL(origin).host)
  if (new Set(hosts).size !== hosts.length) return { ok: false, reason: 'AUTH_ORIGIN, API_ORIGIN and CONSOLE_ORIGIN must be three different hosts' }
  return { ok: true, auth: auth.origin, api: api.origin, console: console_.origin }
}
