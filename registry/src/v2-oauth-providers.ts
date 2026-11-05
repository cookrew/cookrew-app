import { PROVIDER_LABEL, type ProviderId } from '../../src/shared/oauth'

/**
 * THE TWO PROVIDERS, BEHIND ONE SHAPE.
 *
 * Everything here ends in one small fact: a `ProviderProof`. The routes never
 * see a provider's wire, and nothing past this file holds a provider token: it
 * is used once to read who this is and then dropped, because a token nobody
 * keeps is a token nobody can steal.
 *
 * THE KEY IS THE PROVIDER'S IMMUTABLE ID. GitHub logins are reusable and email
 * addresses move, so `subject` is GitHub's numeric id or Google's `sub`.
 *
 * NO PROVIDER IS ON BY DEFAULT. One appears only when both its client id and
 * its secret are configured, and an absent pair is the state the whole feature
 * is built to be invisible in.
 */

export interface ProviderEndpoints {
  authorize: string
  token: string
  user?: string
  emails?: string
  deviceCode?: string
}

export interface ProviderSecrets {
  clientId: string
  clientSecret: string
  /** A fake provider, in a test. Refused unless every one is on loopback. */
  endpoints?: Partial<ProviderEndpoints>
}

export interface OAuthConfig {
  github?: ProviderSecrets
  google?: ProviderSecrets
}

export interface ProviderProof {
  provider: ProviderId
  subject: string
  /** Prefill only. */
  login: string | null
  /** Verified, or null. An unverified address never gets this far. */
  email: string | null
}

export type ProofAnswer = { ok: true; proof: ProviderProof } | { ok: false }

export interface DeviceGrant {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  expiresInMs: number
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'slow'; intervalMs: number }
  | { status: 'over'; why: 'denied' | 'expired' | 'provider' }
  | { status: 'done'; proof: ProviderProof }

export interface OAuthProvider {
  id: ProviderId
  label: string
  authorizeUrl: (input: { state: string; challenge: string; nonce: string; redirectUri: string }) => string
  exchange: (input: { code: string; verifier: string; nonce: string; redirectUri: string }) => Promise<ProofAnswer>
  deviceStart?: () => Promise<DeviceGrant | null>
  devicePoll?: (deviceCode: string) => Promise<DevicePoll>
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ProviderDeps {
  fetch?: Fetch
  now?: () => number
}

/** A provider that hangs must not hold a request open for ever. */
const PROVIDER_TIMEOUT_MS = 10_000
const USER_AGENT = 'cookrew-registry'
/** Identity and verified email. Never repo. */
const GITHUB_SCOPE = 'read:user user:email'
const GOOGLE_SCOPE = 'openid email'
const GITHUB_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com']

const GITHUB_ENDPOINTS: ProviderEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
  emails: 'https://api.github.com/user/emails',
  deviceCode: 'https://github.com/login/device/code'
}

const GOOGLE_ENDPOINTS: ProviderEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token'
}

/**
 * READ THE PAIRS FROM THE ENVIRONMENT — the only place secrets arrive from.
 *
 * Not flags: a flag is readable in `ps`. Half a pair turns that provider off
 * and says so at boot, naming the variable and never its value, because a
 * button that opens a broken flow is worse than no button.
 */
export function readOAuthEnv(env: NodeJS.ProcessEnv, note: (message: string) => void = () => undefined): OAuthConfig {
  const pair = (name: 'GITHUB' | 'GOOGLE'): ProviderSecrets | undefined => {
    const clientId = (env[`${name}_OAUTH_CLIENT_ID`] ?? '').trim()
    const clientSecret = (env[`${name}_OAUTH_CLIENT_SECRET`] ?? '').trim()
    if (clientId === '' && clientSecret === '') return undefined
    if (clientId === '' || clientSecret === '') {
      note(`oauth: ${name}_OAUTH_CLIENT_ID and ${name}_OAUTH_CLIENT_SECRET must both be set; ${name} sign-in is off`)
      return undefined
    }
    return { clientId, clientSecret }
  }
  const github = pair('GITHUB')
  const google = pair('GOOGLE')
  return { ...(github ? { github } : {}), ...(google ? { google } : {}) }
}

/** An override is for a fake on this machine and nothing else. */
function endpointsFor(defaults: ProviderEndpoints, override: Partial<ProviderEndpoints> | undefined): ProviderEndpoints {
  if (override === undefined) return defaults
  for (const value of Object.values(override)) {
    const host = new URL(value).hostname
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error('refusing to start: an OAuth endpoint override must be on loopback')
    }
  }
  return { ...defaults, ...override }
}

const query = (base: string, params: Record<string, string>): string => {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function readJson(http: Fetch, url: string, init: RequestInit): Promise<Record<string, unknown> | unknown[] | null> {
  try {
    const response = await http(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const postForm = (http: Fetch, url: string, fields: Record<string, string>): Promise<Record<string, unknown> | unknown[] | null> =>
  readJson(http, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT
    },
    body: new URLSearchParams(fields).toString()
  })

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * THE ONE ADDRESS WORTH KEEPING: verified, and able to receive mail.
 *
 * GitHub marks its noreply address verified, and a receipt sent there goes
 * nowhere. Primary first, then any other verified one.
 */
export function verifiedGithubEmail(list: unknown): string | null {
  if (!Array.isArray(list)) return null
  const usable = list
    .map(record)
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter((row) => row.verified === true && typeof row.email === 'string')
    .filter((row) => !(row.email as string).endsWith('@users.noreply.github.com'))
  const chosen = usable.find((row) => row.primary === true) ?? usable[0]
  return chosen === undefined ? null : (chosen.email as string)
}

function github(secrets: ProviderSecrets, http: Fetch): OAuthProvider {
  const endpoints = endpointsFor(GITHUB_ENDPOINTS, secrets.endpoints)
  const bearer = (token: string): RequestInit => ({
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT
    }
  })

  /** One use of the token, and then it goes out of scope. */
  const identify = async (token: string): Promise<ProofAnswer> => {
    const user = record(await readJson(http, endpoints.user ?? '', bearer(token)))
    if (user === null || typeof user.id !== 'number') return { ok: false }
    // A person may decline the email scope: that is an identity with no email,
    // not a failed sign-in.
    const emails = await readJson(http, endpoints.emails ?? '', bearer(token))
    return {
      ok: true,
      proof: {
        provider: 'github',
        subject: String(user.id),
        login: typeof user.login === 'string' ? user.login : null,
        email: verifiedGithubEmail(emails)
      }
    }
  }

  return {
    id: 'github',
    label: PROVIDER_LABEL.github,
    authorizeUrl: ({ state, challenge, redirectUri }) =>
      query(endpoints.authorize, {
        client_id: secrets.clientId,
        redirect_uri: redirectUri,
        scope: GITHUB_SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }),
    exchange: async ({ code, verifier, redirectUri }) => {
      const answer = record(
        await postForm(http, endpoints.token, {
          client_id: secrets.clientId,
          client_secret: secrets.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier
        })
      )
      return typeof answer?.access_token === 'string' ? identify(answer.access_token) : { ok: false }
    },
    deviceStart: async () => {
      const answer = record(
        await postForm(http, endpoints.deviceCode ?? '', { client_id: secrets.clientId, scope: GITHUB_SCOPE })
      )
      if (
        typeof answer?.device_code !== 'string' ||
        typeof answer.user_code !== 'string' ||
        typeof answer.verification_uri !== 'string'
      ) {
        return null
      }
      return {
        deviceCode: answer.device_code,
        userCode: answer.user_code,
        verificationUri: answer.verification_uri,
        intervalMs: (typeof answer.interval === 'number' ? answer.interval : 5) * 1000,
        expiresInMs: (typeof answer.expires_in === 'number' ? answer.expires_in : 900) * 1000
      }
    },
    devicePoll: async (deviceCode) => {
      // No client secret: the device grant does not take one, and a secret
      // that is not needed is a secret that should not be sent.
      const answer = record(
        await postForm(http, endpoints.token, {
          client_id: secrets.clientId,
          device_code: deviceCode,
          grant_type: GITHUB_DEVICE_GRANT
        })
      )
      if (answer === null) return { status: 'pending' }
      if (typeof answer.access_token === 'string') {
        const proof = await identify(answer.access_token)
        return proof.ok ? { status: 'done', proof: proof.proof } : { status: 'over', why: 'provider' }
      }
      if (answer.error === 'authorization_pending') return { status: 'pending' }
      if (answer.error === 'slow_down') {
        return { status: 'slow', intervalMs: (typeof answer.interval === 'number' ? answer.interval : 10) * 1000 }
      }
      if (answer.error === 'access_denied') return { status: 'over', why: 'denied' }
      if (answer.error === 'expired_token') return { status: 'over', why: 'expired' }
      return { status: 'over', why: 'provider' }
    }
  }
}

/**
 * The middle of an id_token, unverified.
 *
 * THE SIGNATURE IS NOT CHECKED, and OpenID Connect Core 3.1.3.7 allows exactly
 * this: the token came straight from Google's token endpoint over TLS, in
 * answer to our own client secret. Every claim is still compared.
 */
function idTokenClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const middle = token.split('.')[1]
  if (middle === undefined) return null
  try {
    return record(JSON.parse(Buffer.from(middle, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

function google(secrets: ProviderSecrets, http: Fetch, now: () => number): OAuthProvider {
  const endpoints = endpointsFor(GOOGLE_ENDPOINTS, secrets.endpoints)
  return {
    id: 'google',
    label: PROVIDER_LABEL.google,
    authorizeUrl: ({ state, challenge, nonce, redirectUri }) =>
      query(endpoints.authorize, {
        client_id: secrets.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }),
    exchange: async ({ code, verifier, nonce, redirectUri }) => {
      const answer = record(
        await postForm(http, endpoints.token, {
          grant_type: 'authorization_code',
          client_id: secrets.clientId,
          client_secret: secrets.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier
        })
      )
      const claims = idTokenClaims(answer?.id_token)
      if (claims === null || typeof claims.sub !== 'string' || claims.sub === '') return { ok: false }
      if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) return { ok: false }
      if (claims.aud !== secrets.clientId || claims.nonce !== nonce) return { ok: false }
      if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) return { ok: false }
      return {
        ok: true,
        proof: {
          provider: 'google',
          subject: claims.sub,
          login: null,
          email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email : null
        }
      }
    }
  }
}

/** The configured providers, in button order. An empty map is the off state. */
export function createProviders(config: OAuthConfig = {}, deps: ProviderDeps = {}): ReadonlyMap<ProviderId, OAuthProvider> {
  const http = deps.fetch ?? ((input, init) => fetch(input, init))
  const now = deps.now ?? Date.now
  const providers = new Map<ProviderId, OAuthProvider>()
  if (config.github) providers.set('github', github(config.github, http))
  if (config.google) providers.set('google', google(config.google, http, now))
  return providers
}
