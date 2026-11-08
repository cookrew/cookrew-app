import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Only clients with an implemented, explicitly registered return channel. */
export type AuthClient = 'web' | 'desktop'

const CLIENTS: Readonly<Record<AuthClient, string>> = {
  web: 'https://cookrew.dev/auth/complete',
  desktop: 'cookrew://oauth'
}

const STATE = /^[A-Za-z0-9_-]{22,128}$/
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const GRANT_TTL_MS = 2 * 60_000
const MAX_GRANTS = 1000

export interface AuthorizationRequest {
  clientId: AuthClient
  redirectUri: string
  state: string
  challenge: string
}

/** This names an existing, revocable session; it is never itself a token. */
export interface GrantedSession {
  username: string
  deviceId: string
  jti: string
}

interface HeldGrant {
  request: AuthorizationRequest
  session: GrantedSession
  expiresAt: number
}

/** Strictly validate request values, including the entire registered redirect URI. */
export function authorizationRequest(input: unknown): AuthorizationRequest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  if (raw.clientId !== 'web' && raw.clientId !== 'desktop') return null
  if (raw.redirectUri !== CLIENTS[raw.clientId]) return null
  if (typeof raw.state !== 'string' || !STATE.test(raw.state)) return null
  if (typeof raw.challenge !== 'string' || !CHALLENGE.test(raw.challenge)) return null
  return { clientId: raw.clientId, redirectUri: raw.redirectUri, state: raw.state, challenge: raw.challenge }
}

function matches(challenge: string, verifier: unknown): boolean {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) return false
  const actual = createHash('sha256').update(verifier).digest()
  const expected = Buffer.from(challenge, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Short-lived, bounded and single-use; a restart invalidates outstanding grants. */
export class AuthorizationGrants {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly max: number
  private readonly isLive: (session: GrantedSession) => boolean
  private readonly held = new Map<string, HeldGrant>()

  constructor(options: { isLive: (session: GrantedSession) => boolean; now?: () => number; ttlMs?: number; max?: number }) {
    this.now = options.now ?? Date.now
    this.isLive = options.isLive
    this.ttlMs = options.ttlMs ?? GRANT_TTL_MS
    this.max = options.max ?? MAX_GRANTS
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || !Number.isInteger(this.max) || this.max < 1) {
      throw new Error('Invalid authorization grant limits')
    }
  }

  issue(request: AuthorizationRequest, session: GrantedSession): string {
    if (authorizationRequest(request) === null || !this.isLive(session)) throw new Error('Invalid authorization request or session')
    const now = this.now()
    for (const [code, grant] of this.held) if (grant.expiresAt <= now) this.held.delete(code)
    while (this.held.size >= this.max) {
      const oldest = this.held.keys().next()
      if (oldest.done) break
      this.held.delete(oldest.value)
    }
    const code = randomBytes(32).toString('base64url')
    this.held.set(code, { request: { ...request }, session: { ...session }, expiresAt: now + this.ttlMs })
    return code
  }

  /** Burn on first presentation, including a wrong verifier or client. */
  redeem(code: unknown, client: unknown, verifier: unknown): GrantedSession | null {
    if (typeof code !== 'string') return null
    const grant = this.held.get(code)
    if (!grant) return null
    this.held.delete(code)
    if (this.now() >= grant.expiresAt || client !== grant.request.clientId) return null
    if (!matches(grant.request.challenge, verifier)) return null
    if (!this.isLive(grant.session)) return null
    return { ...grant.session }
  }
}
