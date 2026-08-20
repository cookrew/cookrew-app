import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * IDENTITY (P2-A2) — WebAuthn assertion verification and short-lived tokens.
 *
 * Two things it deliberately is not. It is not a session store: a token is a
 * signed statement the server can check without remembering anything, so a
 * restart does not log anyone out and there is no table to grow. And it is not
 * a password system — nothing here can be replayed by someone who reads the
 * disk, because the only secret is the server's own signing key and it grants
 * nothing that the user's authenticator did not already assert.
 */

export interface IdentityConfig {
  /** WebAuthn RP ID. `localhost` in dev — a secure context by specification. */
  rpId: string
  /** Exact origin the ceremony must have come from. */
  origin: string
  /** Token lifetime. Minutes, not hours: it is a retry ticket, not a session. */
  tokenTtlMs: number
  /** Challenge lifetime. */
  challengeTtlMs: number
}

export const DEV_CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

/**
 * What a token may do. A download token is worth nothing for publishing —
 * spec §6 requires a fresh ceremony per manifest, so a stolen download token
 * must not be a publishing credential.
 */
export type TokenScope = 'download' | 'publish'

export interface TokenClaims {
  sub: string
  scope: TokenScope
  exp: number
}

export type AssertFailure =
  | 'unknown_credential'
  | 'unknown_challenge'
  | 'wrong_type'
  | 'wrong_origin'
  | 'wrong_rp'
  | 'user_not_present'
  | 'bad_signature'

const b64url = (buf: Buffer): string => buf.toString('base64url')
const fromB64url = (value: string): Buffer => Buffer.from(value, 'base64url')

/** A registered credential: its id and the public key that signs for it. */
interface Credential {
  credentialId: string
  jwk: Record<string, unknown>
}

/** Rebuild a verifier key from a stored JWK, choosing the algorithm it names. */
function keyFor(jwk: Record<string, unknown>): { key: KeyObject; hash: 'sha256' | null } {
  const key = createPublicKey({ key: jwk as never, format: 'jwk' })
  // Platform authenticators (Touch ID) sign ES256; software and virtual ones
  // often sign EdDSA. Both are answered rather than forcing one, because a
  // registry that only accepts the convenient algorithm is a registry real
  // hardware cannot log into.
  return { key, hash: jwk.kty === 'OKP' ? null : 'sha256' }
}

export interface AssertionInput {
  credentialId: string
  /** base64url, exactly as the browser produced them. */
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

export class IdentityService {
  private readonly file: string
  private readonly signingKeyFile: string
  private readonly config: IdentityConfig
  private readonly now: () => number
  private readonly challenges = new Map<string, number>()
  private credentials: Credential[] = []
  private signingKey: { publicKey: KeyObject; privateKey: KeyObject } | null = null

  constructor(base: string, config: IdentityConfig = DEV_CONFIG, now: () => number = Date.now) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, 'credentials.json')
    this.signingKeyFile = path.join(base, 'token-key.jwk')
    this.config = config
    this.now = now
    if (existsSync(this.file)) {
      try {
        this.credentials = JSON.parse(readFileSync(this.file, 'utf8')) as Credential[]
      } catch {
        this.credentials = []
      }
    }
  }

  /**
   * Enrol a credential. TOFU, and the same shape as the author-key rule: a
   * credential id already known cannot be re-registered under a different key,
   * so an attacker who can reach the endpoint cannot take over an identity by
   * claiming its id.
   *
   * FLAGGED: M1 accepts a self-reported public key rather than parsing
   * attestation. Over localhost with TOFU that is the honest trade — the first
   * enrolment is trusted, every later assertion is verified — but a public
   * deployment must parse attestation before this endpoint faces the internet.
   */
  register(credentialId: string, jwk: Record<string, unknown>): { ok: boolean; reason?: string } {
    const existing = this.credentials.find((c) => c.credentialId === credentialId)
    if (existing) {
      const same = JSON.stringify(existing.jwk) === JSON.stringify(jwk)
      return same ? { ok: true } : { ok: false, reason: 'credential_exists' }
    }
    this.credentials = [...this.credentials, { credentialId, jwk }]
    writeFileSync(this.file, JSON.stringify(this.credentials, null, 2))
    return { ok: true }
  }

  known(credentialId: string): boolean {
    return this.credentials.some((c) => c.credentialId === credentialId)
  }

  /** Enrolled credential ids. For the dev harness only — see the dev routes. */
  enrolled(): string[] {
    return this.credentials.map((c) => c.credentialId)
  }

  /**
   * Forget every credential. DEV ONLY, and the reason it exists: a gate matrix
   * has to start from a known-empty state or its first case is testing whatever
   * the last run left behind. Reachable only when the registry is started in
   * dev mode.
   */
  forgetAll(): void {
    this.credentials = []
    writeFileSync(this.file, JSON.stringify([], null, 2))
  }

  /** Mint a single-use challenge. It is a nonce, not a session. */
  challenge(): string {
    const value = b64url(randomBytes(32))
    this.challenges.set(value, this.now() + this.config.challengeTtlMs)
    // Opportunistic sweep: expired nonces are worthless, and this keeps the
    // map from being a slow leak on a long-running process.
    for (const [k, exp] of this.challenges) if (exp < this.now()) this.challenges.delete(k)
    return value
  }

  /**
   * Verify an assertion and mint a token. Every check is a separate refusal so
   * a failure says which invariant broke — but the REASON is for the log and
   * the tests, never for the wire: a client learns only that it must try again.
   */
  assert(input: AssertionInput, scope: TokenScope = 'download'):
    | { ok: true; token: string; sub: string }
    | { ok: false; reason: AssertFailure } {
    const credential = this.credentials.find((c) => c.credentialId === input.credentialId)
    if (!credential) return { ok: false, reason: 'unknown_credential' }

    let clientData: { type?: string; origin?: string; challenge?: string }
    try {
      clientData = JSON.parse(fromB64url(input.clientDataJSON).toString('utf8'))
    } catch {
      return { ok: false, reason: 'unknown_challenge' }
    }

    // Single-use: consumed whether or not the rest passes, so a captured
    // challenge cannot be retried against a different assertion.
    const expiry = clientData.challenge ? this.challenges.get(clientData.challenge) : undefined
    if (clientData.challenge) this.challenges.delete(clientData.challenge)
    if (expiry === undefined || expiry < this.now()) return { ok: false, reason: 'unknown_challenge' }

    if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'wrong_type' }
    // Compared against the configured origin, never echoed from the request:
    // trusting clientData's own origin would make the check circular.
    if (clientData.origin !== this.config.origin) return { ok: false, reason: 'wrong_origin' }

    const authData = fromB64url(input.authenticatorData)
    if (authData.byteLength < 37) return { ok: false, reason: 'bad_signature' }
    const rpIdHash = createHash('sha256').update(this.config.rpId).digest()
    if (!authData.subarray(0, 32).equals(rpIdHash)) return { ok: false, reason: 'wrong_rp' }
    // Bit 0 of the flags byte: the user was present. An assertion without it is
    // a signature nobody stood in front of.
    if ((authData[32] & 0x01) === 0) return { ok: false, reason: 'user_not_present' }

    const signed = Buffer.concat([
      authData,
      createHash('sha256').update(fromB64url(input.clientDataJSON)).digest()
    ])
    const { key, hash } = keyFor(credential.jwk)
    let good = false
    try {
      good = verify(hash, signed, key, fromB64url(input.signature))
    } catch {
      good = false
    }
    if (!good) return { ok: false, reason: 'bad_signature' }

    return { ok: true, sub: credential.credentialId, token: this.mint(credential.credentialId, scope) }
  }

  /** The server's token key, generated once and persisted beside the data. */
  private keys(): { publicKey: KeyObject; privateKey: KeyObject } {
    if (this.signingKey) return this.signingKey
    if (existsSync(this.signingKeyFile)) {
      const jwk = JSON.parse(readFileSync(this.signingKeyFile, 'utf8')) as Record<string, unknown>
      const privateKey = createPrivateKey({ key: jwk as never, format: 'jwk' })
      this.signingKey = { privateKey, publicKey: createPublicKey(privateKey) }
      return this.signingKey
    }
    // Generated once, persisted beside the data. Restarting the registry must
    // not invalidate every outstanding token — that would read to a client as
    // the gate randomly demanding re-authentication.
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(this.signingKeyFile, JSON.stringify(pair.privateKey.export({ format: 'jwk' })))
    this.signingKey = pair
    return pair
  }

  private mint(sub: string, scope: TokenScope): string {
    const claims: TokenClaims = { sub, scope, exp: this.now() + this.config.tokenTtlMs }
    const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'))
    const signature = sign(null, Buffer.from(body, 'utf8'), this.keys().privateKey)
    return `${body}.${b64url(signature)}`
  }

  /**
   * Claims for a token, or null. Null for malformed, mis-signed and expired
   * alike — a caller must not be able to tell those apart and act differently.
   */
  verifyToken(token: string): TokenClaims | null {
    try {
      const [body, signature] = token.split('.')
      if (!body || !signature) return null
      if (!verify(null, Buffer.from(body, 'utf8'), this.keys().publicKey, fromB64url(signature))) {
        return null
      }
      const claims = JSON.parse(fromB64url(body).toString('utf8')) as TokenClaims
      if (typeof claims.exp !== 'number' || claims.exp < this.now()) return null
      if (claims.scope !== 'download' && claims.scope !== 'publish') return null
      return claims
    } catch {
      return null
    }
  }
}
