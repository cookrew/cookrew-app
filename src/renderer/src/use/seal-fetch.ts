/**
 * HOW THE SEALED SESSION'S REQUESTS LEAVE (path/seal-client.ts; unlocking a
 * Mac from afar). The session rides the relay's prefix and nothing else. On a
 * machine's own page that is this origin and a plain fetch. On the console it
 * is the registry's API host: another origin, no cookie, and the account
 * session in its header, which only an address under the relay's machine
 * prefix is ever given (machine-scope.ts · relayHeadersForUrl).
 */
import { CROSS_ORIGIN_NO_COOKIE, isAbsolute } from '../data-plane'
import { relayHeadersForUrl } from '../machine-scope'

export function sealFetchFor(base: string): typeof fetch {
  if (!isAbsolute(base)) return (input, init) => fetch(input, init)
  return (input, init) => {
    const session = relayHeadersForUrl(String(input))
    const own = init?.headers as Record<string, string> | undefined
    const headers = own || Object.keys(session).length > 0 ? { headers: { ...own, ...session } } : {}
    return fetch(input, { ...init, ...CROSS_ORIGIN_NO_COOKIE, ...headers })
  }
}
