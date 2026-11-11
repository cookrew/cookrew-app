/**
 * WHAT THIS PAGE WAS BUILT FOR. The console is static files: nothing is
 * injected into it when it is served, so the two registry hosts it talks to
 * are written into its index.html when it is built, as plain <meta> tags
 * (a strict content policy has no inline script to read a global from):
 *
 *   <meta name="cookrew-mode" content="console">
 *   <meta name="cookrew-api"  content="https://api.cookrew.dev">
 *   <meta name="cookrew-auth" content="https://auth.cookrew.dev">
 *
 * Each must be a bare origin, https except on a loopback name (a local
 * registry in a test). Anything else and the page is not the console: it asks
 * nobody anything rather than sending a session to a host it cannot name.
 */
export interface ConsoleConfig {
  readonly apiOrigin: string
  readonly authOrigin: string
}

const LOOPBACK = /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1)$/

function originOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null
  if (url.protocol === 'https:') return url.origin
  return url.protocol === 'http:' && LOOPBACK.test(url.hostname) ? url.origin : null
}

const meta = (doc: Pick<Document, 'querySelector'>, name: string): string | null => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null

/** Where the account page is, from the console: the auth host's. Null on any page that is not the console. */
export const accountPageOf = (config: ConsoleConfig | null): string | null => (config === null ? null : `${config.authOrigin}/account`)

/** The console's configuration, or null on any page that is not the console. */
export function readConsoleConfig(doc: Pick<Document, 'querySelector'>): ConsoleConfig | null {
  if (meta(doc, 'cookrew-mode') !== 'console') return null
  const apiOrigin = originOf(meta(doc, 'cookrew-api'))
  const authOrigin = originOf(meta(doc, 'cookrew-auth'))
  return apiOrigin === null || authOrigin === null ? null : { apiOrigin, authOrigin }
}
