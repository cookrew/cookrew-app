/**
 * THIRD-PARTY SIGN-IN — the facts the registry and the app must agree on.
 *
 * Two providers and no third. A provider replaces the password step and nothing
 * after it: the ladder, the device attach and the session are unchanged. The
 * handle stays Cookrew's own, which is why a provider's name only ever reaches
 * `suggestHandle` and never the account.
 */

export type ProviderId = 'github' | 'google'

export const PROVIDER_IDS: readonly ProviderId[] = ['github', 'google']

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)

export const PROVIDER_LABEL: Record<ProviderId, string> = { github: 'GitHub', google: 'Google' }

/** What GET /v2/oauth/providers lists. Empty means no button anywhere. */
export interface ProviderOffer {
  id: ProviderId
  label: string
  /** Can a machine with no browser sign in with this one? */
  device: boolean
}

/**
 * WHAT A TRIP THROUGH THE PROVIDER IS FOR.
 *
 * `sign-in` is the password step's replacement. `link` adds an identity to the
 * signed-in account. `step-up` proves the session's owner is at the provider
 * right now, for one act, which is what a passwordless account has in place of
 * `current`.
 */
export type OAuthIntent = 'sign-in' | 'link' | 'step-up'

export const isOAuthIntent = (value: unknown): value is OAuthIntent =>
  value === 'sign-in' || value === 'link' || value === 'step-up'

/**
 * WHERE THE BROWSER GOES BACK TO, and there is no URL in it on purpose. The
 * only places are the fixed scheme and a port on 127.0.0.1, so this field
 * cannot become an open redirect.
 */
export interface OAuthBack {
  scheme: boolean
  port?: number
}

/** One linked identity, as its owner reads it. Never public. */
export interface LinkedProvider {
  provider: ProviderId
  /** The provider's display name for it: shown, and never a key. */
  login: string | null
  linkedAt: number
  /** "Not me" was pressed on a sign-in through this link. */
  paused: boolean
}

/** Only ever copied from a provider's verified claim. Never typed. */
export interface VerifiedEmail {
  address: string
  via: ProviderId
  verifiedAt: number
}

/** The app's way back in, on the path the registry page links to. */
export const OAUTH_SCHEME_HOST = 'oauth'
export const OAUTH_LOOPBACK_PATH = '/oauth/return'

const HANDLE_MAX = 32

/**
 * A PROVIDER'S NAME, AS A PREFILL.
 *
 * Lowercased and trimmed to the shape the registry accepts. An empty answer is
 * a real answer: the field simply starts blank.
 */
export function suggestHandle(login: string | null, email: string | null): string {
  const raw = login ?? email?.split('@')[0] ?? ''
  const shaped = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, HANDLE_MAX)
    .replace(/-+$/, '')
  return shaped.startsWith('acct-') ? '' : shaped
}
