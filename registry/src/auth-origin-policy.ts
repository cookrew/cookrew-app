import { isIP } from 'node:net'

export type AuthOriginDecision = 'page' | 'redirect' | 'asset' | 'auth-api' | 'deny' | 'other-origin'

const ASSETS: ReadonlySet<string> = new Set([
  '/assets/auth-site.js',
  '/assets/auth-site.css',
  '/assets/device-id.js',
  '/assets/inter.woff2',
  '/assets/jetbrains-mono.woff2'
])

/**
 * Strict RFC 3986 host[:port] parser. `allowUnderscore` admits interior underscores in DNS-style
 * labels (container service names such as `my_registry`); it is only used for request Host headers,
 * never for configured origins, and cannot normalize to a name without underscores.
 */
function parseAuthority(authority: string, allowUnderscore = false): { hostname: string; port: string | null } | null {
  const match = (allowUnderscore
    ? /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)(?::([0-9]+))?$/
    : /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/).exec(authority)
  if (!match) return null
  const rawHostname = match[1]
  const port = match[2] ?? null
  if (port !== null && (port !== String(Number(port)) || Number(port) < 1 || Number(port) > 65535)) return null
  if (rawHostname.startsWith('[')) {
    const address = rawHostname.slice(1, -1)
    if (isIP(address) !== 6) return null
    return { hostname: new URL(`http://${rawHostname}`).hostname.toLowerCase(), port }
  }
  const hostname = rawHostname.toLowerCase().replace(/\.$/, '')
  const label = allowUnderscore ? /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/ : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  if (hostname.length > 253 || !hostname || hostname.split('.').some((part) => !label.test(part))) return null
  if (/^[0-9.]+$/.test(hostname) && isIP(hostname) !== 4) return null
  return { hostname, port }
}

function parseProductOrigin(origin: string): { hostname: string; port: string; defaultPort: string } | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname) return null
  return { hostname, port: url.port || defaultPort, defaultPort }
}

export function validateOriginIsolation(authOrigin: string | null, productOrigin: string | undefined): void {
  if (productOrigin === undefined) return
  const auth = /^(https?):\/\/([^/?#]+)\/?$/.exec(authOrigin ?? 'https://auth.cookrew.dev')
  const authAuthority = auth && parseAuthority(auth[2])
  const product = parseProductOrigin(productOrigin)
  if (!auth || !authAuthority || !product) throw new Error('Invalid origin configuration for auth host isolation')
  if (product.hostname === 'auth.cookrew.dev') throw new Error('Auth origin overlaps product origin')
  const authDefault = auth[1] === 'https' ? '443' : '80'
  const authPort = authAuthority.port ?? authDefault
  if (authAuthority.hostname === product.hostname &&
    (authPort === product.port || (product.port === product.defaultPort && authPort === authDefault))) {
    throw new Error('Auth origin overlaps product origin')
  }
}

/** Only the endpoints needed for sign-in and its factor ladder live on this origin. */
function isAuthApi(path: string, method: string): boolean {
  if (path === '/v2/sessions' && method === 'POST') return true
  if (path === '/v2/accounts' && method === 'POST') return true
  if (path === '/v2/oauth/providers' && method === 'GET') return true
  if (path === '/v2/recovery' && method === 'POST') return true
  if (/^\/v2\/sessions\/[0-9a-f-]{36}$/.test(path) && method === 'GET') return true
  if (/^\/v2\/sessions\/[0-9a-f-]{36}\/(approve|totp|recovery)$/.test(path) && method === 'POST') return true
  if (/^\/v2\/sessions\/[0-9a-f-]{36}\/passkey\/options$/.test(path) && method === 'GET') return true
  if (/^\/v2\/sessions\/[0-9a-f-]{36}\/passkey$/.test(path) && method === 'POST') return true
  if (path === '/v2/sessions/passkey/options' && method === 'GET') return true
  if (path === '/v2/sessions/passkey' && method === 'POST') return true
  return false
}

/** Host routing must be exact: never derive trust from a suffix or a forwarded header. */
export function authOriginPolicy(input: {
  configuredOrigin: string | null
  host: string | undefined
  path: string
  method: string
}): AuthOriginDecision {
  let expected: ReturnType<typeof parseAuthority> = null
  let defaultPort = '443'
  if (input.configuredOrigin !== null) {
    const match = /^(https?):\/\/([^/?#]+)\/?$/.exec(input.configuredOrigin)
    expected = match ? parseAuthority(match[2]) : null
    const loopback = expected && ['127.0.0.1', 'localhost', '[::1]'].includes(expected.hostname)
    if (!match || !expected || (match[1] !== 'https' && !loopback)) throw new Error('Invalid auth origin configuration')
    defaultPort = match[1] === 'https' ? '443' : '80'
  }
  const actual = parseAuthority(input.host ?? '', true)
  if (!actual) return 'deny'
  const matchesConfigured = expected !== null && actual.hostname === expected.hostname && (actual.port ?? defaultPort) === (expected.port ?? defaultPort)
  if (!matchesConfigured) return actual.hostname === 'auth.cookrew.dev' ? 'deny' : 'other-origin'
  if (input.method === 'GET' && input.path === '/') return 'redirect'
  if ((input.method === 'GET' || input.method === 'HEAD') && input.path === '/sign-in') return 'page'
  if ((input.method === 'GET' || input.method === 'HEAD') && ASSETS.has(input.path)) return 'asset'
  if (isAuthApi(input.path, input.method)) return 'auth-api'
  return 'deny'
}
