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

export const TOKEN_KEY = 'cookrew-pairing-token'

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
 * Lift a token out of whatever the user pasted: a full pairing URL, or the
 * bare token itself.
 *
 * A URL that carries no `token=` returns null rather than being treated as a
 * bare token — otherwise pasting the wrong URL "succeeds" and then fails on
 * the next request, which is exactly the confusion this screen exists to end.
 */
export function tokenFromInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const fromQuery = new URL(trimmed).searchParams.get('token')
      return fromQuery && fromQuery.length > 0 ? fromQuery : null
    } catch {
      return null
    }
  }
  // A bare token never contains whitespace or a slash.
  return /[\s/]/.test(trimmed) ? null : trimmed
}

/** What to tell the user, given why they are blocked. */
export function reauthMessage(scope: AuthScope): string {
  return scope === 'read-only'
    ? 'This device is paired read-only. Open the pairing URL from the desktop to make changes.'
    : 'This device is not paired with Cookrew any more. Run `cookrew mobile` on the desktop and paste the URL it prints.'
}

export function createAuthStore(input: AuthStoreInput): AuthStore {
  const listeners = new Set<(blocked: AuthError | null) => void>()
  let blocked: AuthError | null = null

  // Boot order: a token on the URL wins (the user just opened a fresh pairing
  // link), then localStorage, then a sessionStorage token from a pairing made
  // before this module moved storage.
  let token: string | null = (() => {
    const fromUrl = input.search ? new URLSearchParams(input.search).get('token') : null
    if (fromUrl) {
      input.local.setItem(TOKEN_KEY, fromUrl)
      return fromUrl
    }
    const stored = input.local.getItem(TOKEN_KEY)
    if (stored) return stored
    const legacy = input.session?.getItem(TOKEN_KEY) ?? null
    if (legacy) input.local.setItem(TOKEN_KEY, legacy)
    return legacy
  })()

  const notify = (): void => {
    for (const listener of listeners) listener(blocked)
  }

  return {
    token: () => token,
    save: (next) => {
      token = next
      input.local.setItem(TOKEN_KEY, next)
      if (blocked) {
        blocked = null
        notify()
      }
    },
    clear: () => {
      token = null
      input.local.removeItem(TOKEN_KEY)
      input.session?.removeItem(TOKEN_KEY)
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
    search: window.location.search
  })
  // The token must not linger in the address bar (or in a screenshot of it).
  try {
    if (new URLSearchParams(window.location.search).get('token')) {
      const clean = new URL(window.location.href)
      clean.searchParams.delete('token')
      window.history.replaceState(null, '', clean)
    }
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
