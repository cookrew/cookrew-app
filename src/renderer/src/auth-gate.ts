// Pairing credential + what happens when it stops working.
//
// THE FAILURE THIS REPLACES
// -------------------------
// The token lived in sessionStorage and every write went through a `post()`
// that ended in `.catch(() => undefined)`. So when the token went stale — a
// desktop restart used to mint a new one on every launch — the phone did not
// report anything. Buttons kept depressing, keystrokes went nowhere, and the
// UI looked alive. A 401 is not an edge case here; it is the single most
// likely error this client will ever see, and it was the one error it threw
// away.
//
// Everything below is injectable so it can be tested without a DOM.
//
// REACH v2.1 added two facts this module has to hold, both in pairing-scope.ts
// and both about WHERE the credential lives rather than what it is: the token
// now arrives in a URL FRAGMENT (so cookrew.dev never sees it), and one origin
// now serves many Macs (so the storage key has to name one).

import { clientBase } from './api-base'
import {
  ROOT_TOKEN_KEY,
  scrubPairingFromUrl,
  tokenFromFragment,
  tokenKeyForBase
} from './pairing-scope'

export type AuthScope = 'pairing' | 'read-only' | 'none'

/** Thrown by the remote API when the server refuses the credential. */
export class AuthError extends Error {
  readonly scope: AuthScope

  constructor(message: string, scope: AuthScope = 'none') {
    super(message)
    this.name = 'AuthError'
    this.scope = scope
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError
}

/**
 * The key a direct pairing uses. Still exported under its old name because it
 * is the ROOT key and the root is still the common case — a phone scanning the
 * LAN URL off the Mac is unchanged by any of this.
 */
export const TOKEN_KEY = ROOT_TOKEN_KEY

/** The slice of Storage this module uses; lets tests pass a plain object. */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface AuthStoreInput {
  /** Survives tab discard — where the token now lives. */
  local: StorageLike
  /** Read once for tokens paired before the move to localStorage. */
  session?: StorageLike
  /** `window.location.search` at boot. */
  search?: string
  /** `window.location.hash` at boot — where `#pair=<token>` arrives. */
  hash?: string
  /**
   * The prefix this bundle was served under (`clientBase()`), which names the
   * desktop. Defaults to the real one so no call site has to pass it; tests
   * pass it to stand somewhere else.
   */
  base?: string
}

export interface AuthStore {
  token: () => string | null
  save: (token: string) => void
  clear: () => void
  /** Current blocked state, or null while authorized. */
  blocked: () => AuthError | null
  report: (error: AuthError) => void
  /** Cleared by a successful re-pair. */
  resolve: () => void
  subscribe: (listener: (blocked: AuthError | null) => void) => () => void
}

/**
 * Lift a token out of whatever the user pasted. THREE FORMS, deliberately:
 *
 *   the canonical URL   https://cookrew.dev/relay/@me/desktop/<id>/#pair=<t>
 *   the direct URL      https://192-168-2-40.<id>.d.cookrew.dev:8643/?token=<t>
 *   the bare token      <t>
 *
 * All three are things the Mac prints or a person ends up holding, and which
 * one arrives depends on whether the phone scanned a QR, copied a line out of
 * a terminal, or shared a link from another phone. Refusing any of them would
 * be refusing the same credential for the shape of its wrapper.
 *
 * A URL that carries NEITHER returns null rather than being treated as a bare
 * token — otherwise pasting the address bar of an already-open companion
 * "succeeds" here and fails on the next request, which is exactly the
 * confusion this screen exists to end.
 */
export function tokenFromInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const fromQuery = url.searchParams.get('token')
      if (fromQuery && fromQuery.length > 0) return fromQuery
      return tokenFromFragment(url.hash)
    } catch {
      return null
    }
  }
  // A bare token never contains whitespace or a slash. Not shape-checked any
  // harder than that on purpose: a token typed by a person predates v2.1 and
  // an over-tight rule here would refuse a credential the Mac would accept.
  return /[\s/]/.test(trimmed) ? null : trimmed
}

/**
 * THE NOT PAIRED CARD, IN ONE PLACE.
 *
 * The copy is the feature here — the card is the ONLY pairing surface left
 * (the /me Desktops row lost SCAN QR, TYPE KEY, the key field and LINK), so
 * every sentence has to name a real place the reader can go. "The desktop
 * rejected that token" named nothing; "get it from the Mac again" does.
 */
export const REAUTH_COPY = {
  title: 'Not paired',
  readOnlyTitle: 'Read-only device',
  unpaired:
    "Scan the QR on the Mac's avatar → Pair a phone, or paste what `cookrew mobile` printed.",
  readOnly:
    'This device is paired read-only. Open the pairing URL from the desktop to make changes.',
  label: 'Pairing URL or token',
  placeholder: 'https://cookrew.dev/…#pair=…',
  pair: 'Pair',
  checking: 'Checking…',
  continueReadOnly: 'Continue read-only',
  shape: 'That is not a pairing URL or token. Paste the whole line the Mac printed.',
  refused:
    'The Mac did not take that token. It may have been rotated — get it from the Mac again.'
} as const

/** What to tell the user, given why they are blocked. */
export function reauthMessage(scope: AuthScope): string {
  return scope === 'read-only' ? REAUTH_COPY.readOnly : REAUTH_COPY.unpaired
}

export function createAuthStore(input: AuthStoreInput): AuthStore {
  const listeners = new Set<(blocked: AuthError | null) => void>()
  let blocked: AuthError | null = null

  // WHICH MAC THIS STORE IS FOR. At the root the origin was the desktop, so
  // the key could not be ambiguous; under a relay prefix it names the desktop
  // explicitly. See pairing-scope.ts.
  const base = input.base ?? clientBase()
  const key = tokenKeyForBase(base)
  const atRoot = key === ROOT_TOKEN_KEY

  // Boot order: a credential on the URL wins (the user just opened a fresh
  // pairing link), then storage under this desktop's key, then — at the root
  // only — a sessionStorage token from a pairing made before this module moved
  // storage. The legacy key names no desktop, so under a relay prefix it says
  // nothing about whether it belongs to THIS Mac and must not be claimed.
  let token: string | null = (() => {
    const fromQuery = input.search ? new URLSearchParams(input.search).get('token') : null
    const fromUrl = fromQuery || tokenFromFragment(input.hash ?? '')
    if (fromUrl) {
      input.local.setItem(key, fromUrl)
      return fromUrl
    }
    const stored = input.local.getItem(key)
    if (stored) return stored
    if (!atRoot) return null
    const legacy = input.session?.getItem(key) ?? null
    if (legacy) input.local.setItem(key, legacy)
    return legacy
  })()

  const notify = (): void => {
    for (const listener of listeners) listener(blocked)
  }

  return {
    token: () => token,
    save: (next) => {
      token = next
      input.local.setItem(key, next)
      if (blocked) {
        blocked = null
        notify()
      }
    },
    clear: () => {
      token = null
      input.local.removeItem(key)
      input.session?.removeItem(key)
    },
    blocked: () => blocked,
    report: (error) => {
      // Every keystroke on an unpaired phone produces a 401. Notifying on
      // each one would re-render the app continuously, so only a CHANGE in
      // the blocked state is published.
      if (blocked?.scope === error.scope) return
      blocked = error
      notify()
    },
    resolve: () => {
      if (!blocked) return
      blocked = null
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function browserStore(): AuthStore {
  const missing: StorageLike = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined
  }
  // Private-mode Safari throws on storage access rather than returning null.
  const safe = (pick: () => Storage): StorageLike => {
    try {
      const storage = pick()
      storage.getItem(TOKEN_KEY)
      return storage
    } catch {
      return missing
    }
  }
  const store = createAuthStore({
    local: safe(() => window.localStorage),
    session: safe(() => window.sessionStorage),
    search: window.location.search,
    hash: window.location.hash
  })
  // THE CREDENTIAL MUST NOT SURVIVE THE BOOT. It is read above — before the
  // first authenticated request — and taken off the URL here, so it is in no
  // screenshot, no share sheet, no reload and no `document.referrer`. The
  // fragment matters more than the query ever did: `#pair=` was chosen so
  // cookrew.dev never receives the token, and a fragment left in place would
  // hand it to the next person the page is shown to.
  try {
    const clean = scrubPairingFromUrl(window.location.href)
    if (clean) window.history.replaceState(null, '', clean)
  } catch {
    // A history API that refuses is not worth failing the boot over.
  }
  return store
}

let singleton: AuthStore | null = null

/** The app-wide store; created on first use so tests can avoid the DOM. */
export function authStore(): AuthStore {
  if (!singleton) singleton = browserStore()
  return singleton
}

/**
 * The pairing token as a QUERY PARAM, for clients that cannot set a header.
 *
 * There are exactly two, and both are EventSource: the workspace stream and a
 * terminal's pane stream. EventSource has no headers by construction, which is
 * the honest half of the reason reads went ungated for so long — so this is
 * the seam that lets reads be gated without losing the streams.
 *
 * PREFER A HEADER WHEREVER ONE IS POSSIBLE. A token in a URL travels into
 * places a header does not: server logs, `document.referrer`, a screenshot of
 * an address bar. Nothing here is new — the pairing URL itself carries
 * `?token=` and `pairingAuthorized` has always accepted it — but a plain
 * `fetch` can set a header and therefore should, which is why this is used at
 * two call sites and not three.
 *
 * Returns the path unchanged when there is no token: an unpaired client should
 * get the same 401 as an anonymous one, not a URL with `token=null` in it.
 */
export function tokenParam(path: string, token = authStore().token()): string {
  if (!token) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * Authorization header for a token-bearing client, or {} when unpaired.
 *
 * The token is a default parameter rather than a closed-over read so this is
 * testable without a DOM — every call site still omits it and gets the store.
 */
export function authHeaders(token = authStore().token()): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}
