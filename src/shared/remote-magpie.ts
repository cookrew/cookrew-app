import type { GuideDesktop } from './devices-guide'
/**
 * ANOTHER COMPUTER'S MAGPIE, WHAT COOKREW STILL SAYS ABOUT IT.
 *
 * Magpie has the provider built in (`remote-magpie`, 0.1.3935): the other
 * computer's models and routing groups arrive as `<id>/…`. Cookrew no longer
 * types the line that adds one: magpie's CLI takes a key only as an argument,
 * where every same-user process (a served seat included) can read it and the
 * shell keeps it in its history. The key is typed into Magpie's own settings
 * page instead, opened in a card (route/magpie-web.ts · routing/magpie-card.ts).
 *
 * What stays here is the one rule Cookrew still applies to an address it shows
 * (Share with my devices): plain http only where the key does not cross an open
 * network. A private address can still be a hotel's; the panel says so.
 */

export const REMOTE_MAGPIE_PRESET = 'remote-magpie'
export const MAGPIE_PORT = 3425

const LAN_SUFFIXES = ['.local', '.lan', '.home.arpa', '.ts.net']

function ipv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null
  const octets = parts.map(Number)
  return octets.every((o) => o <= 255) ? octets : null
}

/** A private range, a tailnet (100.64/10) or a LAN name. Not the same as a TRUSTED network. */
export function privateHost(host: string): boolean {
  const ip = ipv4(host)
  if (ip !== null) {
    const [a, b] = ip
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const name = host.toLowerCase()
  return LAN_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** Whether an address is on a tailnet is Tailscale's word, not the address's look: main/route/tailnet.ts. */

/**
 * MAGPIE OVER THE SEAL (lane Magpie). Another computer of the account uses this
 * one's Magpie through a cookrew-seal/2 stream of this kind (main/magpie-remote/),
 * never a tunnel onto loopback and never plain http across a LAN.
 */
export const MAGPIE_REMOTE_KIND = 'magpie'
/** On a `magpie` stream: the asking computer wants a key of its own (POST, JSON `{ name }`). */
export const MAGPIE_KEY_PATH = '/.cookrew/magpie-key'
/** On a `magpie` stream: the asking computer gives its key back (POST). */
export const MAGPIE_KEY_RETURN_PATH = '/.cookrew/magpie-key/return'
/**
 * What the asking computer's own Magpie is told its key is. Not a secret: the
 * real key stays in Cookrew's main process, which puts it on each request it seals.
 */
export const SEALED_PLACEHOLDER_KEY = 'cookrew-sealed'
/**
 * The loopback port of the asking computer's forwarder (main/magpie-remote/forward.ts).
 * One port, never a fallback: Magpie's providers name it, and moving would leave them
 * pointing at whatever took the old one.
 */
export const MAGPIE_FORWARD_PORTS: readonly number[] = [3428]

export interface MagpieKeyAnswerOk {
  readonly ok: true
  readonly key: string
  readonly id: string
}
export type MagpieKeyAnswer = MagpieKeyAnswerOk | { readonly ok: false; readonly why: string }

/** The Routing panel's "Your other computers" (owner-only IPC magpie-remote:list). */
export interface MagpieRemoteList {
  readonly signedIn: boolean
  /** The forwarder's port, or null while it is not running. */
  readonly forwarder: number | null
  /** Keys from other computers are sealed with the keychain here. */
  readonly sealed: boolean
  readonly problem: string | null
  /** False when the account's desktops could not be had: the list is empty for that reason. */
  readonly desktopsKnown: boolean
  readonly desktops: readonly GuideDesktop[]
}

/**
 * WHAT ANOTHER COMPUTER MAY ASK THIS ONE'S MAGPIE, over the seal: the model endpoints and
 * the read-only quota view, by exact path and method. Magpie serves far more under /v1/
 * (keys, limits, library, update, join, mcp, native, profiling: 0.1.3935), and Go's router
 * decodes `%6d` in a path, so nothing is matched by prefix and no escaped or dotted path
 * is let through. Asked at both ends (main/magpie-remote/forward.ts and serve.ts).
 */
export const MAGPIE_REMOTE_ROUTES: Readonly<Record<string, readonly string[]>> = {
  POST: ['/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/v1/responses', '/v1/completions', '/v1/embeddings'],
  GET: ['/v1/models', '/v1/magpie/quotas']
}

/** A plain query: names, values, `=`, `&` and a few safe marks; never an escape. */
const PLAIN_QUERY = /^[A-Za-z0-9_.,:=&-]*$/
/**
 * The query names a model request may carry (Claude Code sends `?beta=true`, a model list pages).
 * Nothing else: Magpie also reads credentials from a query (`?key=`), which would stand beside
 * the checked key unchecked.
 */
const QUERY_NAMES = new Set(['beta', 'limit', 'after_id', 'before_id'])

export function modelRoute(method: string, path: string): boolean {
  const at = path.indexOf('?')
  const bare = at < 0 ? path : path.slice(0, at)
  const query = at < 0 ? '' : path.slice(at + 1)
  if (!PLAIN_QUERY.test(query) || /[%\\]/.test(bare)) return false
  if (query !== '' && !query.split('&').every((pair) => QUERY_NAMES.has(pair.split('=')[0]))) return false
  return (MAGPIE_REMOTE_ROUTES[method] ?? []).includes(bare)
}

/**
 * The request headers that cross to another computer's Magpie, by name. Everything else is
 * dropped: other credential headers (`x-goog-api-key`, which Magpie also reads), Magpie's own
 * steering headers (`x-magpie-*`), cookies, hop-by-hop and forwarding headers.
 */
const FORWARD_HEADERS = new Set(['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent', 'x-request-id', 'session_id', 'originator', 'x-claude-code-session-id'])

/** The headers for the far Magpie: the allowed ones, and the one verified key in BOTH credential headers. */
export function magpieHeaders(asked: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const kept = Object.entries(asked).filter(([name]) => FORWARD_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-stainless-'))
  return { ...Object.fromEntries(kept.map(([name, value]) => [name.toLowerCase(), value])), authorization: `Bearer ${key}`, 'x-api-key': key }
}
