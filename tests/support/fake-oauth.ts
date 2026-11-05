import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthConfig } from '../../registry/src/v2-oauth-providers'

/**
 * A FAKE GITHUB AND A FAKE GOOGLE, ON LOOPBACK.
 *
 * It speaks the wire the real two speak, including the parts that are checks
 * rather than data: the client secret, the redirect, and PKCE. A fake that
 * accepted anything would prove nothing about whether the registry sends them.
 */

export const GITHUB_CLIENT = { clientId: 'gh-client', clientSecret: 'gh-secret' }
export const GOOGLE_CLIENT = { clientId: 'gg-client', clientSecret: 'gg-secret' }

export interface FakeGithubUser {
  id: number
  login: string
  emails: readonly { email: string; primary: boolean; verified: boolean }[]
}

export interface FakeGoogleUser {
  sub: string
  email: string
  email_verified: boolean
}

interface Grant {
  challenge: string
  redirectUri: string
  nonce: string
  scope: string
  user: FakeGithubUser | FakeGoogleUser
}

export interface FakeOAuth {
  origin: string
  /** Who the next consent screen is answered as. */
  github: FakeGithubUser
  google: FakeGoogleUser
  /** Every authorize query, so a test can read what was asked for. */
  authorized: URLSearchParams[]
  /** Answer the next consent with `error=access_denied`. */
  denyNext: () => void
  /** What the next device poll says: 'pending', 'slow', 'denied', 'expired', 'ok'. */
  device: { answer: 'pending' | 'slow' | 'denied' | 'expired' | 'ok'; polls: number; lastBody: URLSearchParams | null }
  /** Tamper with the next id_token's claims. */
  googleClaims: Record<string, unknown>
  config: () => OAuthConfig
  close: () => Promise<void>
}

const read = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

const send = (response: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  response.writeHead(code, { 'content-type': 'application/json' })
  response.end(payload)
}

const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

const idToken = (claims: Record<string, unknown>): string =>
  ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((part) => Buffer.from(part).toString('base64url')).join('.')

export async function fakeOAuth(): Promise<FakeOAuth> {
  const grants = new Map<string, Grant>()
  const tokens = new Map<string, FakeGithubUser>()
  let deny = false
  const fake: FakeOAuth = {
    origin: '',
    github: {
      id: 583231,
      login: 'Octo-Cat',
      emails: [{ email: 'octo@example.com', primary: true, verified: true }]
    },
    google: { sub: '1104', email: 'ada@example.com', email_verified: true },
    authorized: [],
    denyNext: () => {
      deny = true
    },
    device: { answer: 'pending', polls: 0, lastBody: null },
    googleClaims: {},
    config: () => ({
      github: { ...GITHUB_CLIENT, endpoints: endpointsOf(fake.origin, 'github') },
      google: { ...GOOGLE_CLIENT, endpoints: endpointsOf(fake.origin, 'google') }
    }),
    close: async () => undefined
  }

  const authorize = (url: URL, response: ServerResponse, user: FakeGithubUser | FakeGoogleUser): void => {
    fake.authorized.push(url.searchParams)
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const back = new URL(redirectUri)
    back.searchParams.set('state', url.searchParams.get('state') ?? '')
    if (deny) {
      deny = false
      back.searchParams.set('error', 'access_denied')
    } else {
      const code = randomBytes(8).toString('hex')
      grants.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri,
        nonce: url.searchParams.get('nonce') ?? '',
        scope: url.searchParams.get('scope') ?? '',
        user
      })
      back.searchParams.set('code', code)
    }
    response.writeHead(302, { location: back.toString() })
    response.end()
  }

  /** The checks a real token endpoint makes; the grant, or null with the refusal sent. */
  const redeem = (body: URLSearchParams, response: ServerResponse, client: typeof GITHUB_CLIENT): Grant | null => {
    const grant = grants.get(body.get('code') ?? '')
    const refused =
      body.get('client_id') !== client.clientId ||
      body.get('client_secret') !== client.clientSecret ||
      grant === undefined ||
      body.get('redirect_uri') !== grant.redirectUri ||
      s256(body.get('code_verifier') ?? '') !== grant.challenge
    if (refused) {
      send(response, 200, { error: 'bad_verification_code' })
      return null
    }
    grants.delete(body.get('code') ?? '')
    return grant ?? null
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', fake.origin)
    if (url.pathname === '/github/authorize') return authorize(url, response, fake.github)
    if (url.pathname === '/google/authorize') return authorize(url, response, fake.google)
    if (url.pathname === '/github/token') {
      const body = await read(request)
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        fake.device.polls += 1
        fake.device.lastBody = body
        const answer = fake.device.answer
        if (answer === 'pending') return send(response, 200, { error: 'authorization_pending' })
        if (answer === 'slow') return send(response, 200, { error: 'slow_down', interval: 10 })
        if (answer === 'denied') return send(response, 200, { error: 'access_denied' })
        if (answer === 'expired') return send(response, 200, { error: 'expired_token' })
        const token = randomBytes(8).toString('hex')
        tokens.set(token, fake.github)
        return send(response, 200, { access_token: token, token_type: 'bearer', scope: 'read:user user:email' })
      }
      const grant = redeem(body, response, GITHUB_CLIENT)
      if (grant === null) return
      const token = randomBytes(8).toString('hex')
      tokens.set(token, grant.user as FakeGithubUser)
      return send(response, 200, { access_token: token, token_type: 'bearer', scope: grant.scope })
    }
    if (url.pathname === '/github/device/code') {
      await read(request)
      return send(response, 200, {
        device_code: 'dev-code-secret',
        user_code: 'WDJB-MJHT',
        verification_uri: `${fake.origin}/github/device`,
        expires_in: 900,
        interval: 5
      })
    }
    if (url.pathname === '/github/user' || url.pathname === '/github/emails') {
      const user = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (user === undefined) return send(response, 401, { message: 'Bad credentials' })
      return send(response, 200, url.pathname === '/github/user' ? { id: user.id, login: user.login } : user.emails)
    }
    if (url.pathname === '/google/token') {
      const body = await read(request)
      const grant = redeem(body, response, GOOGLE_CLIENT)
      if (grant === null) return
      const user = grant.user as FakeGoogleUser
      return send(response, 200, {
        id_token: idToken({
          iss: 'https://accounts.google.com',
          aud: GOOGLE_CLIENT.clientId,
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: grant.nonce,
          ...user,
          ...fake.googleClaims
        })
      })
    }
    send(response, 404, {})
  }

  const server: Server = createServer((request, response) => void handle(request, response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return fake
}

function endpointsOf(origin: string, provider: 'github' | 'google'): Record<string, string> {
  return provider === 'github'
    ? {
        authorize: `${origin}/github/authorize`,
        token: `${origin}/github/token`,
        user: `${origin}/github/user`,
        emails: `${origin}/github/emails`,
        deviceCode: `${origin}/github/device/code`
      }
    : { authorize: `${origin}/google/authorize`, token: `${origin}/google/token` }
}

/**
 * THIS LANE'S RULE, as a function: nothing here may send a credential to a
 * registry that is not on loopback. Cookrew panes export COOKREW_REGISTRY as
 * the production origin, so every test names its own and passes through here.
 */
export function loopbackOnly(origin: string): string {
  const host = new URL(origin).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`refusing a non-loopback registry: ${origin}`)
  return origin
}

/** PKCE, as a client mints it. */
export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: s256(verifier), state: randomBytes(16).toString('base64url') }
}

/**
 * Walk the browser's half: the provider's consent, the callback, and the page
 * that hands back to the app. Answers what the page offered.
 */
export async function walkBrowser(authorizeUrl: string): Promise<{ page: string; status: number; headers: Headers }> {
  const consent = await fetch(authorizeUrl, { redirect: 'manual' })
  const callback = consent.headers.get('location') ?? ''
  const landed = await fetch(callback, { redirect: 'manual' })
  return { page: await landed.text(), status: landed.status, headers: landed.headers }
}

/** The handoff and state in a return page's first link. */
export function returnOf(page: string): { handoff: string | null; state: string | null; error: string | null } {
  const decoded = page.replaceAll('&amp;', '&')
  const fragment = /cookrew:\/\/oauth#([^"]+)"/.exec(decoded)?.[1] ?? /\/oauth\/return\?([^"]+)"/.exec(decoded)?.[1] ?? ''
  const params = new URLSearchParams(fragment)
  return { handoff: params.get('handoff'), state: params.get('state'), error: params.get('error') }
}
