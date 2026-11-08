import { createHash, createPublicKey, verify } from 'node:crypto'
import type { FetchLike } from '../../src/main/account-v2'
import { AUTH_TRANSCRIPT_CONTEXT } from '../../src/main/account-browser-auth'

/**
 * A REGISTRY THAT SPEAKS THE AUTH WIRE (src/shared/auth-site.ts), as a fetch.
 *
 * It checks what it is sent the way the real one does: the proof against the
 * key the request named, the verifier against the challenge. It also answers
 * the legacy provider wire, so a fallback can be watched taking the old way.
 */

export const ORIGIN = 'https://registry.test'
export const AUDIENCE = 'https://auth.cookrew.dev'
export const NOW = 1_800_000_000_000
export const DAY = 24 * 60 * 60 * 1000

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')

export const transcriptFor = (request: string, deviceId: string, audience: string = AUDIENCE): string =>
  [
    AUTH_TRANSCRIPT_CONTEXT,
    'purpose:authenticate-device',
    `audience:${audience}`,
    `transaction:${request}`,
    `challenge:${'c'.repeat(43)}`,
    'expires:9999999999999',
    `device:${deviceId}`,
    'key:x',
    'name:"MacBook Pro"',
  ].join('\n')

export interface Seen {
  path: string
  body: Record<string, unknown>
  auth: string | null
}

/** A registry that speaks the auth wire, and the legacy oauth wire for a fallback. */
export class FakeRegistry {
  seen: Seen[] = []
  opened: Record<string, unknown> | null = null
  proofs: boolean[] = []
  code = 'one-use-code'
  username = 'octo'
  hasPassword = false
  /** What the redeem answers instead of a session. */
  redeem: (() => Response) | null = null
  /** What POST /v2/auth/requests answers instead of a request. */
  requests: (() => Response) | null = null
  transcript: string | null = null
  authorizeUrl: string | null = null
  /** A terminal's polls answered 202 before the 201. */
  pending = 0
  over: 'denied' | 'expired' | null = null
  /** The legacy provider trip, for the link fallback. */
  legacyState: string | null = null

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const headers = (init?.headers ?? {}) as Record<string, string>
    this.seen.push({ path: url.pathname, body, auth: headers.authorization ?? null })
    return this.answer(url.pathname, body)
  }

  private answer(pathname: string, body: Record<string, unknown>): Response {
    if (pathname === '/v2/auth/requests') return this.open(body)
    if (pathname === '/v2/auth/requests/req-1/proof') return this.prove(body)
    if (pathname === '/v2/auth/token') return this.spend(body)
    if (pathname.startsWith('/v2/oauth/') && pathname.endsWith('/start')) {
      this.legacyState = String(body.state)
      return Response.json({ authorizeUrl: 'https://github.com/login/oauth/authorize?x=1' }, { status: 201 })
    }
    if (pathname === '/v2/oauth/redeem') return Response.json({ status: 'linked', provider: 'google' })
    if (pathname.startsWith('/v2/accounts/')) return Response.json({ username: this.username })
    return new Response('not here', { status: 404 })
  }

  private open(body: Record<string, unknown>): Response {
    if (this.requests !== null) return this.requests()
    this.opened = body
    const device = body.device as { id: string }
    const cli = body.client === 'cli'
    return Response.json(
      {
        request: 'req-1',
        transcript: this.transcript ?? transcriptFor('req-1', device.id, this.audience()),
        expiresAt: NOW + 600_000,
        authorizeUrl: this.authorizeUrl ?? (cli ? `${AUDIENCE}/device` : `${AUDIENCE}/?request=req-1`),
        ...(cli ? { userCode: 'BCDF-GHJK', verificationUri: `${AUDIENCE}/device`, intervalMs: 1 } : {}),
      },
      { status: 201 },
    )
  }

  /** The origin the page is on: what a transcript must name as its audience. */
  private audience(): string {
    return this.authorizeUrl === null ? AUDIENCE : new URL(this.authorizeUrl).origin
  }

  private prove(body: Record<string, unknown>): Response {
    const device = (this.opened?.device ?? {}) as { id: string; jwk: Record<string, unknown> }
    const transcript = this.transcript ?? transcriptFor('req-1', device.id, this.audience())
    let good = false
    try {
      const key = createPublicKey({ key: device.jwk as never, format: 'jwk' })
      good = verify(null, Buffer.from(transcript, 'utf8'), key, Buffer.from(String(body.signature), 'base64url'))
    } catch {
      good = false
    }
    this.proofs.push(good)
    return good ? new Response(null, { status: 204 }) : Response.json({ error: 'bad_proof' }, { status: 403 })
  }

  private spend(body: Record<string, unknown>): Response {
    if (this.opened === null || sha256(String(body.verifier)) !== this.opened.challenge) {
      return Response.json({ error: 'bad_credentials' }, { status: 401 })
    }
    if (body.code !== undefined && body.code !== this.code) return Response.json({ error: 'bad_credentials' }, { status: 401 })
    if (body.code === undefined && body.request !== 'req-1') return Response.json({ error: 'bad_credentials' }, { status: 401 })
    if (this.over !== null) return Response.json({ error: 'flow_over', why: this.over }, { status: 410 })
    if (body.code === undefined && this.pending > 0) {
      this.pending -= 1
      return Response.json({ status: 'pending', intervalMs: 1 }, { status: 202 })
    }
    if (this.redeem !== null) return this.redeem()
    if (this.opened.intent === 'link') return Response.json({ status: 'linked', provider: this.opened.provider })
    const device = this.opened.device as { id: string }
    return Response.json(
      { token: 'tok-new', exp: NOW + 30 * DAY, deviceId: device.id, username: this.username, hasPassword: this.hasPassword },
      { status: 201 },
    )
  }

  calls(pathname: string): Seen[] {
    return this.seen.filter((seen) => seen.path === pathname)
  }
}
