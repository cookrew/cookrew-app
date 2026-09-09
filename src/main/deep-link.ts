import { COOKREW_REGISTRY, parseServeAddress } from './import-session'
import type { DeepLink } from '../shared/deep-link'

export type { DeepLink } from '../shared/deep-link'

/**
 * THE DEEP LINK — `cookrew://<verb>/…`, and the canonical https team page.
 *
 * Three verbs, each with exactly one shape. A link is parsed, never repaired:
 * it can arrive from a web page, a chat, a pasteboard or another app's argv,
 * and the only defence against a link that means something other than what
 * it says is to refuse every shape this file does not name. The team address
 * is judged by `parseServeAddress` — the import sheet's own rule — so a name
 * that the sheet would refuse cannot be smuggled in by wrapping it in a scheme.
 */

export const DEEP_LINK_SCHEME = 'cookrew'

/** A preset's content address — the only install id the app knows. */
const PRESET_ID = /^sha256:[0-9a-f]{64}$/

/** `@handle/team`, verified by the sheet's own parser; null otherwise. */
function publishedName(segments: readonly string[]): string | null {
  if (segments.length !== 2) return null
  const target = parseServeAddress(`${segments[0]}/${segments[1]}`)
  // A relayed name is the only thing a deep link may carry: a LAN address
  // parses too, but here it would be a link that opens a socket to whatever
  // it names, which is exactly the thing a link must not be able to do.
  return target?.door ?? null
}

function decodedSegments(pathname: string): readonly string[] | null {
  try {
    return pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
}

function fromScheme(url: URL): DeepLink | null {
  const segments = decodedSegments(url.pathname)
  if (segments === null) return null
  const verb = url.hostname
  if (verb === 'import') {
    // The one query this verb takes. Anything else is a link asking for a
    // behaviour the app does not have, and guessing would be inventing one.
    const keys = [...url.searchParams.keys()]
    const session = url.searchParams.get('session')
    if (keys.length > 1 || (keys.length === 1 && (keys[0] !== 'session' || session !== 'new'))) {
      return null
    }
    const address = publishedName(segments)
    if (address === null) return null
    return session === 'new' ? { verb, address, session: 'new' } : { verb, address }
  }
  if (url.search.length > 0) return null
  if (verb === 'install') {
    if (segments.length !== 1 || !PRESET_ID.test(segments[0])) return null
    return { verb, presetId: segments[0] }
  }
  if (verb === 'serve') {
    const address = publishedName(segments)
    return address === null ? null : { verb, address }
  }
  return null
}

/** `https://cookrew.dev/@drej/team` and the @-less form the site prints. */
function fromRegistryPage(url: URL): DeepLink | null {
  if (url.origin !== COOKREW_REGISTRY || url.search.length > 0) return null
  const segments = decodedSegments(url.pathname)
  if (segments === null || segments.length !== 2) return null
  const first = segments[0].startsWith('@') ? segments[0] : `@${segments[0]}`
  const address = publishedName([first, segments[1]])
  return address === null ? null : { verb: 'import', address }
}

/** Parse one link, or null. Never throws, never rewrites. */
export function parseDeepLink(raw: string): DeepLink | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.username || url.password || url.hash) return null
  if (url.protocol === `${DEEP_LINK_SCHEME}:`) return fromScheme(url)
  if (url.protocol === 'https:') return fromRegistryPage(url)
  return null
}

/**
 * The link a SECOND INSTANCE was launched with. On Windows and Linux the OS
 * hands a protocol link to a fresh process as an argument, and the lock holder
 * gets that argv — this finds the link in it. Only the scheme counts: an https
 * argument on a command line is a file to open, not a link to act on.
 */
export function deepLinkInArgv(argv: readonly string[]): DeepLink | null {
  const raw = argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`))
  return raw === undefined ? null : parseDeepLink(raw)
}

export interface DeepLinkQueue {
  /** A parsed link to deliver — now, or once the renderer can hear it. */
  push(link: DeepLink): void
  /** The renderer finished loading: flush what waited, deliver directly after. */
  ready(): void
  /** The window closed: hold again until the next one is ready. */
  gone(): void
}

/**
 * A link that arrives before the window exists — the app was launched BY the
 * link, which is the common case — is not lost and not dropped on a renderer
 * that has not subscribed yet. Held until `ready`, delivered in order.
 */
export function createDeepLinkQueue(deliver: (link: DeepLink) => void): DeepLinkQueue {
  let waiting: readonly DeepLink[] = []
  let listening = false
  return {
    push(link) {
      if (listening) deliver(link)
      else waiting = [...waiting, link]
    },
    ready() {
      listening = true
      const held = waiting
      waiting = []
      held.forEach(deliver)
    },
    gone() {
      listening = false
    }
  }
}
