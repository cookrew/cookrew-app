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

/**
 * Default SHAPE, not a deployment truth. The origin here is only correct for a
 * registry actually listening on 8790 — see `identityConfigFor`, which is how
 * anything that binds a port should build its config.
 */
export const DEV_CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

export type ConfigRefusal = { ok: false; reason: string }

/**
 * Build an identity config from the port the server will actually bind, and
 * REFUSE when the inputs contradict each other.
 *
 * THE HOUR THIS COSTS WHEN IT IS WRONG (Tinker's LOW-1, and he is not the only
 * one who would lose it). WebAuthn compares the assertion's origin against a
 * configured string, exactly, and its rpIdHash against a configured domain. Get
 * either wrong and EVERY assertion fails — not with "wrong origin", because the
 * refusal reason is deliberately server-side, but as a blanket 401 that reads
 * exactly like a broken credential. So the failure points at the passkey, which
 * is the one part that is fine.
 *
 * Two contradictions are possible and both are now refused rather than
 * absorbed. An `--origin` naming a different port than `--port` is a config
 * nobody meant. And the rpId is DERIVED from the origin's hostname rather than
 * fixed, because `localhost` and `127.0.0.1` are different origins AND
 * different RP IDs to a browser — the pair that made the old default a trap for
 * anyone who read the boot banner and used the address it printed.
 */
export function identityConfigFor(input: {
  port: number
  origin?: string
}): { ok: true; config: IdentityConfig } | ConfigRefusal {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { ok: false, reason: `--port ${input.port} is not a port` }
  }
  const raw = input.origin ?? `http://localhost:${input.port}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `--origin ${raw} is not a URL` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `--origin ${raw} must be http or https` }
  }
  // An origin is scheme + host + port and nothing else; a path or query here
  // means the value will never equal what a browser sends.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: `--origin ${raw} must be scheme://host[:port] with no path` }
  }
  const statedPort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  /**
   * The port check applies ONLY when the origin names this machine.
   *
   * It exists to catch `--origin http://localhost:8790 --port 8791`: a typo
   * that turns every ceremony into a blanket 401 reading like a broken
   * passkey. But behind a reverse proxy the two ports differ on purpose —
   * the process binds 8791 while the world reaches https://cookrew.dev — and
   * refusing that made the only real deployment shape unbootable.
   *
   * A non-local hostname means something else is terminating the connection,
   * so the bound port says nothing about what a browser will send.
   */
  const localOrigin = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  if (localOrigin && statedPort !== input.port) {
    return {
      ok: false,
      reason: `--origin ${raw} names port ${statedPort} but --port is ${input.port}; a browser would be refused on both`
    }
  }
  return {
    ok: true,
    config: {
      ...DEV_CONFIG,
      rpId: url.hostname,
      // Normalised through URL.origin so the stored value is the exact string a
      // browser computes — a trailing slash or an explicit :80 would compare
      // unequal forever.
      origin: url.origin
    }
  }
}

/**
 * What a token may do. A download token is worth nothing for publishing —
 * spec §6 requires a fresh ceremony per manifest, so a stolen download token
 * must not be a publishing credential.
 */
export type TokenScope = 'download' | 'publish' | 'call'

export interface TokenClaims {
  sub: string
  scope: TokenScope
  exp: number
  /**
   * A `call` token is minted for ONE door — `@handle/team` — and a door checks
   * this against its own name before it seats the caller. Without it a token
   * minted to knock on one door would open every door that trusts this
   * registry; with it a stolen token is worth exactly one address.
   */
  aud?: string
}

/** The shape a call token's audience must have: a door's canonical name. */
const AUDIENCE = /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export type AssertFailure =
  | 'unknown_credential'
  | 'unknown_challenge'
  | 'wrong_type'
  | 'wrong_origin'
  | 'wrong_rp'
  | 'user_not_present'
  | 'bad_signature'
  /**
   * The challenge was real, unexpired and unused — and issued for something
   * else. A login nonce presented as a countersignature, a publish
   * countersignature presented as a key rotation, or either presented for a
   * different preset. Its own refusal because it is the one that catches a
   * replay rather than a forgery.
   */
  | 'wrong_binding'

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
  /**
   * Outstanding nonces, each remembering WHAT IT WAS ISSUED FOR.
   *
   * `binding` is null for the login ceremony and the countersign payload's hex
   * digest for a countersignature. Recording it here is what makes a
   * countersignature unreplayable rather than merely operation-labelled: the
   * nonce is consumed on first use and the server checks, against its own
   * record, that the ceremony being completed is the one it issued.
   */
  private readonly challenges = new Map<string, { exp: number; binding: string | null }>()
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

  /** Mint a single-use challenge for the LOGIN ceremony. A nonce, not a session. */
  challenge(): string {
    return this.mintChallenge(null)
  }

  /**
   * Mint a single-use challenge for countersigning one specific operation on one
   * specific (author key, preset) pair.
   *
   * Spec §6 wants a fresh ceremony per manifest, and this is what makes that
   * true rather than aspirational: the nonce this returns will only ever
   * complete the ceremony it was issued for.
   */
  countersignChallenge(binding: string): string {
    return this.mintChallenge(binding)
  }

  private mintChallenge(binding: string | null): string {
    const value = b64url(randomBytes(32))
    this.challenges.set(value, { exp: this.now() + this.config.challengeTtlMs, binding })
    // Opportunistic sweep: expired nonces are worthless, and this keeps the
    // map from being a slow leak on a long-running process.
    for (const [k, entry] of this.challenges) {
      if (entry.exp < this.now()) this.challenges.delete(k)
    }
    return value
  }

  /**
   * Verify an assertion and mint a token. Every check is a separate refusal so
   * a failure says which invariant broke — but the REASON is for the log and
   * the tests, never for the wire: a client learns only that it must try again.
   */
  assert(input: AssertionInput, scope: TokenScope = 'download', aud?: string):
    | { ok: true; token: string; sub: string }
    | { ok: false; reason: AssertFailure | 'bad_audience' } {
    // A call token without a door, or with a malformed one, is refused rather
    // than minted broad: the audience is what confines it.
    if (scope === 'call' && (typeof aud !== 'string' || !AUDIENCE.test(aud))) {
      return { ok: false, reason: 'bad_audience' }
    }
    // Binding null: a login ceremony completes only a login nonce. A
    // countersign nonce presented here is `wrong_binding`, so a publish
    // ceremony can never be spent as a session instead.
    const out = this.verifyAssertion(input, null)
    if (!out.ok) return out
    return {
      ok: true,
      sub: out.credentialId,
      token: this.mint(out.credentialId, scope, scope === 'call' ? aud : undefined)
    }
  }

  /**
   * THE TOKEN KEY'S PUBLIC HALF, as a JWK — for a DOOR to verify a call token
   * without asking this registry on every knock. Public by nature: it is the
   * half meant to be handed out, and handing it out is what lets a door seat a
   * caller while the registry is unreachable.
   */
  publicKeyJwk(): Record<string, unknown> {
    return this.keys().publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  }

  /**
   * Verify a COUNTERSIGNATURE — a full assertion, not a bare signature.
   *
   * The difference is the whole point. A bare signature check proves only that
   * a key signed some bytes; an assertion proves an authenticator produced it,
   * with the user present, for a challenge this server issued moments ago and
   * has now spent. That is what makes a countersignature a deliberate human act
   * rather than a value an attacker can lift out of the public log and re-send.
   */
  countersign(
    input: AssertionInput,
    binding: string
  ): { ok: true; credentialId: string } | { ok: false; reason: AssertFailure } {
    return this.verifyAssertion(input, binding)
  }

  /**
   * The one WebAuthn verification, shared by both ceremonies. Two of them would
   * eventually differ, and the one that mattered less would be the weaker.
   */
  private verifyAssertion(
    input: AssertionInput,
    expectedBinding: string | null
  ): { ok: true; credentialId: string } | { ok: false; reason: AssertFailure } {
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
    const entry = clientData.challenge ? this.challenges.get(clientData.challenge) : undefined
    if (clientData.challenge) this.challenges.delete(clientData.challenge)
    if (entry === undefined || entry.exp < this.now()) {
      return { ok: false, reason: 'unknown_challenge' }
    }
    // The nonce was issued for a purpose, and this is it — checked against the
    // server's OWN record rather than anything the request asserts about
    // itself. Both directions matter: a login nonce cannot countersign, and a
    // publish countersignature cannot be spent as a key rotation.
    if (entry.binding !== expectedBinding) return { ok: false, reason: 'wrong_binding' }

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

    return { ok: true, credentialId: credential.credentialId }
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

  private mint(sub: string, scope: TokenScope, aud?: string): string {
    const claims: TokenClaims = {
      sub,
      scope,
      exp: this.now() + this.config.tokenTtlMs,
      ...(aud === undefined ? {} : { aud })
    }
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
      if (claims.scope !== 'download' && claims.scope !== 'publish' && claims.scope !== 'call') return null
      if (claims.scope === 'call' && (typeof claims.aud !== 'string' || !AUDIENCE.test(claims.aud))) return null
      return claims
    } catch {
      return null
    }
  }
}
