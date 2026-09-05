import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * IDENTITY v2 — TOKENS.
 *
 * The same key and the same two-part format the registry already mints with
 * (`base64url(claims).base64url(ed25519 signature)`), read from the same file
 * beside the data. One key, so a door that already fetched the registry's
 * public half can verify a v2 token without learning anything new — and a
 * second key would have meant a second thing to rotate and a second way to be
 * wrong about which one signed what.
 *
 * A token is still a signed statement rather than a session row: a restart
 * logs nobody out. What IS remembered — a jti per device — exists only so a
 * revoked device's outstanding tokens can be refused, which is the one thing
 * a stateless token cannot do for itself.
 */

export type V2Scope = 'session' | 'call' | 'canvas'

export interface V2Claims {
  sub: string
  dev: string
  scope: V2Scope
  exp: number
  jti: string
  /** The seat a call token was minted under, when the door is paid. */
  seat?: string
  /**
   * A call token names ONE door and a canvas token ONE desktop; a session
   * token names neither. Two shapes, because the two things being named are
   * different kinds of thing: `@handle/team` and a device id.
   */
  aud?: string
}

/**
 * What a verifier is asking for. A bare scope is the whole question for a
 * session; a canvas token has to be checked against the desktop it was minted
 * FOR, or one desktop's token opens another.
 */
export interface V2Expected {
  scope: V2Scope
  aud?: string
  /**
   * THE SEAT THIS TOKEN WAS MINTED FOR, when there is one.
   *
   * A door verifies the signature offline and learns the account from `sub`;
   * `seat` is what lets it say WHICH fact admitted this person, so an owner
   * ending a seat and a caller holding a ten-minute token are traceable to
   * each other. Absent for the owner of the door and for a team that charges
   * nothing — neither is admitted by a seat, so neither may claim one.
   */
  seat?: string
}

export interface Minted {
  token: string
  exp: number
  jti: string
}

/** Thirty days: a session follows a person across a month of ordinary use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Ten minutes: a call token is carried to one door and spent. */
export const CALL_TTL_MS = 10 * 60 * 1000
/** Ten minutes: a canvas token is carried to one desktop and spent, the same way. */
export const CANVAS_TTL_MS = 10 * 60 * 1000

const AUDIENCE = /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** A canvas token's audience is a device id, which is a uuid and nothing else. */
const DEVICE_AUDIENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const audienceFits = (scope: V2Scope, aud: unknown): boolean => {
  if (scope === 'call') return typeof aud === 'string' && AUDIENCE.test(aud)
  if (scope === 'canvas') return typeof aud === 'string' && DEVICE_AUDIENCE.test(aud)
  return true
}

export interface V2TokensOptions {
  /**
   * Ids whose tokens are refused however well they verify — device ids and
   * session ids alike. Both, because this is the ONLY revocation channel a
   * door verifying offline can see: it has our published list and nothing
   * else. A password change ends other sittings by putting their session ids
   * here, which stops their tokens without detaching the phone they were on.
   */
  revoked?: () => ReadonlySet<string>
  now?: () => number
}

export class V2Tokens {
  private readonly keyFile: string
  private readonly revoked: () => ReadonlySet<string>
  private readonly now: () => number
  private keys: { publicKey: KeyObject; privateKey: KeyObject } | null = null

  constructor(base: string, options: V2TokensOptions = {}) {
    mkdirSync(base, { recursive: true })
    // THE SAME FILE identity.ts writes. Same name, same JWK format, so
    // whichever of the two is asked first mints it and the other reads it.
    this.keyFile = path.join(base, 'token-key.jwk')
    this.revoked = options.revoked ?? (() => new Set<string>())
    this.now = options.now ?? Date.now
  }

  mintSession(sub: string, dev: string, jti: string = randomUUID()): Minted {
    const exp = this.now() + SESSION_TTL_MS
    return { token: this.mint({ sub, dev, scope: 'session', exp, jti }), exp, jti }
  }

  /**
   * A CALL TOKEN — for the phases that put a person at somebody else's door.
   * Minted here in phase 1 so the audience rule lives with the format rather
   * than being invented again later beside the gate that needs it.
   */
  mintCallToken(sub: string, dev: string, aud: string, seat?: string): Minted {
    if (!AUDIENCE.test(aud)) throw new Error(`"${aud}" is not a door — a call token names @handle/team`)
    const exp = this.now() + CALL_TTL_MS
    const jti = randomUUID()
    return {
      token: this.mint({ sub, dev, scope: 'call', exp, jti, aud, ...(seat === undefined ? {} : { seat }) }),
      exp,
      jti
    }
  }

  /**
   * A CANVAS TOKEN — what a signed-in phone or browser carries to the owner's
   * OWN desktop. It names the desktop it may open (`aud`) and the device
   * asking (`dev`), so the desktop can verify it offline against /v2/keys and
   * still know which of the account's devices is at the door.
   */
  mintCanvasToken(sub: string, dev: string, aud: string): Minted {
    if (!DEVICE_AUDIENCE.test(aud)) throw new Error('a canvas token names one desktop, by its device id')
    const exp = this.now() + CANVAS_TTL_MS
    const jti = randomUUID()
    return { token: this.mint({ sub, dev, scope: 'canvas', exp, jti, aud }), exp, jti }
  }

  /**
   * Claims, or null. Null for malformed, mis-signed, expired, out-of-scope and
   * revoked alike: a caller must not be able to tell those apart and act
   * differently on the difference.
   */
  verify(token: unknown, expect: V2Scope | V2Expected): V2Claims | null {
    if (typeof token !== 'string') return null
    const want: V2Expected = typeof expect === 'string' ? { scope: expect } : expect
    try {
      const [body, signature, ...rest] = token.split('.')
      if (!body || !signature || rest.length > 0) return null
      if (!verify(null, Buffer.from(body, 'utf8'), this.pair().publicKey, Buffer.from(signature, 'base64url'))) {
        return null
      }
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as V2Claims
      if (typeof claims.sub !== 'string' || claims.sub === '') return null
      if (typeof claims.dev !== 'string' || claims.dev === '') return null
      if (typeof claims.jti !== 'string' || claims.jti === '') return null
      if (typeof claims.exp !== 'number' || claims.exp < this.now()) return null
      if (claims.scope !== want.scope) return null
      if (!audienceFits(claims.scope, claims.aud)) return null
      // A token minted for another audience is not this one's, however well
      // it verifies: one desktop's open must never open the next.
      if (want.aud !== undefined && claims.aud !== want.aud) return null
      // A seat claim is an id or it is not there; anything else is a token
      // somebody shaped by hand and a door must not read it as a seat.
      if (claims.seat !== undefined && (typeof claims.seat !== 'string' || claims.seat === '')) return null
      const revoked = this.revoked()
      if (revoked.has(claims.dev) || revoked.has(claims.jti)) return null
      return claims
    } catch {
      return null
    }
  }

  /** The public half, for a door that verifies offline. */
  publicKeyJwk(): Record<string, unknown> {
    return this.pair().publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  }

  private mint(claims: V2Claims): string {
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const signature = sign(null, Buffer.from(body, 'utf8'), this.pair().privateKey)
    return `${body}.${signature.toString('base64url')}`
  }

  private pair(): { publicKey: KeyObject; privateKey: KeyObject } {
    if (this.keys) return this.keys
    if (existsSync(this.keyFile)) {
      const jwk = JSON.parse(readFileSync(this.keyFile, 'utf8')) as Record<string, unknown>
      const privateKey = createPrivateKey({ key: jwk as never, format: 'jwk' })
      this.keys = { privateKey, publicKey: createPublicKey(privateKey) }
      return this.keys
    }
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(this.keyFile, JSON.stringify(pair.privateKey.export({ format: 'jwk' })), { mode: 0o600 })
    this.keys = pair
    return pair
  }
}
