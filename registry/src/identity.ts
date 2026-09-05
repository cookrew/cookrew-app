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
import { AccountStore, LinkCodes, type Device } from './accounts'

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
  /**
   * A `link` token's lifetime. Two minutes, not ten: it vouches for ONE new
   * device and is read off one screen onto another, so its whole life is the
   * few seconds a person spends doing that.
   */
  linkTtlMs?: number
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
  challengeTtlMs: 90 * 1000,
  linkTtlMs: 2 * 60 * 1000
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
export type TokenScope = 'download' | 'publish' | 'call' | 'account' | 'link' | 'serve'

const SCOPES: readonly TokenScope[] = ['download', 'publish', 'call', 'account', 'link', 'serve']

/** A scope a caller may ask for by name, defaulting to the narrowest. */
export function readScope(value: unknown): TokenScope {
  return SCOPES.find((s) => s === value) ?? 'download'
}

export interface TokenClaims {
  sub: string
  /**
   * WHICH DEVICE of the account signed. New with accounts, and the reason
   * revocation can mean anything at all: a token names the key that produced
   * it, so a door refreshing the registry's key document learns that a stolen
   * laptop's tokens are worthless before they expire.
   */
  dev?: string
  scope: TokenScope
  exp: number
  /**
   * A `call` token is minted for ONE door — `@handle/team` — and a door checks
   * this against its own name before it seats the caller. Without it a token
   * minted to knock on one door would open every door that trusts this
   * registry; with it a stolen token is worth exactly one address.
   *
   * A `link` token's audience is the ONE device id it may vouch for.
   */
  aud?: string
  /** A `link` token's single-use id. Spent at the registry, never reusable. */
  jti?: string
}

/** The shape a call token's audience must have: a door's canonical name. */
const AUDIENCE = /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** A link token's audience: the new device's id. */
const DEVICE_AUDIENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The bytes one device signs to vouch for another. Versioned, so it can move. */
export function bindStatement(handle: string, deviceId: string, thumbprint: string): string {
  return `cookrew-bind/1 ${handle} ${deviceId} ${thumbprint}`
}

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

/**
 * A REAL WebAuthn assertion, as `navigator.credentials.get` returns it once the
 * ArrayBuffers are base64url-encoded. Distinct from `AssertionInput` because
 * the credential id here is the AUTHENTICATOR's — a random value that means
 * nothing until the accounts table maps it to a device — rather than a handle.
 */
export interface PasskeyAssertion {
  /** Optional: the account the page believes it is signing in as. */
  handle?: string
  credential: {
    id: string
    rawId?: string
    type?: string
    response: {
      clientDataJSON: string
      authenticatorData: string
      signature: string
      userHandle?: string
    }
  }
}

/** One key that might have produced an assertion, and who it would speak for. */
interface Candidate {
  sub: string
  dev?: string
  jwk: Record<string, unknown>
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
  /**
   * THE ACCOUNTS, beside the ceremony rather than inside it.
   *
   * A handle is no longer one key: it is a name with devices, and this is the
   * table the ceremony resolves a signer against. It is public because the
   * routes that bind and revoke devices are their own module — the ceremony has
   * no opinion about who may edit an account, only about who signed.
   */
  readonly accounts: AccountStore
  /** Codes a person reads off one screen and types into another. */
  readonly linkCodes: LinkCodes
  /** Spent `link` token ids. Single use is the point of the scope. */
  private readonly spentJti = new Map<string, number>()

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
    this.accounts = new AccountStore(base, now)
    this.linkCodes = new LinkCodes(config.linkTtlMs ?? 2 * 60 * 1000, now)
    // MIGRATION, at boot and non-destructively: every handle that had a
    // credential keeps working, now as an account with one device, and
    // credentials.json is left untouched so a rollback loses nothing.
    this.accounts.migrate(this.credentials)
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
    // The same enrolment, in the shape everything after this reads: a handle
    // with one device. Additive, so an existing account is never touched — this
    // route cannot add a key to somebody else's account.
    this.accounts.migrate([{ credentialId, jwk }])
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
    this.accounts.forgetAll()
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
    | { ok: true; token: string; sub: string; dev?: string }
    | { ok: false; reason: AssertFailure | 'bad_audience' } {
    const audience = this.checkAudience(scope, aud)
    if (!audience.ok) return audience
    // Binding null: a login ceremony completes only a login nonce. A
    // countersign nonce presented here is `wrong_binding`, so a publish
    // ceremony can never be spent as a session instead.
    const out = this.verifyAssertion(input, null)
    if (!out.ok) return out
    return {
      ok: true,
      sub: out.credentialId,
      ...(out.dev === undefined ? {} : { dev: out.dev }),
      token: this.mint(out.credentialId, scope, { aud: audience.aud, dev: out.dev })
    }
  }

  /**
   * A REAL WebAuthn assertion — a platform passkey, not the site's software
   * ceremony. The credential id here belongs to the AUTHENTICATOR, so the only
   * thing that turns it into an account is the devices table: a passkey signs
   * for whichever account bound it, and for no other.
   */
  assertPasskey(input: PasskeyAssertion, scope: TokenScope = 'download', aud?: string):
    | { ok: true; token: string; sub: string; dev: string }
    | { ok: false; reason: AssertFailure | 'bad_audience' } {
    const audience = this.checkAudience(scope, aud)
    if (!audience.ok) return audience
    const credential = input?.credential
    if (
      typeof credential !== 'object' ||
      credential === null ||
      typeof credential.id !== 'string' ||
      typeof credential.response !== 'object' ||
      credential.response === null
    ) {
      return { ok: false, reason: 'unknown_credential' }
    }
    if (credential.type !== undefined && credential.type !== 'public-key') {
      return { ok: false, reason: 'unknown_credential' }
    }
    const found = this.accounts.byCredentialId(credential.id)
    // A revoked passkey is not a passkey. Same refusal as an unknown one: which
    // of the two it was is not a client's business.
    if (found === null || found.device.revokedAt !== undefined) {
      return { ok: false, reason: 'unknown_credential' }
    }
    if (typeof input.handle === 'string' && input.handle.replace(/^@/, '').toLowerCase() !== found.handle) {
      return { ok: false, reason: 'unknown_credential' }
    }
    const out = this.verifyCeremony(
      [{ sub: found.handle, dev: found.device.id, jwk: found.device.jwk }],
      {
        clientDataJSON: credential.response.clientDataJSON,
        authenticatorData: credential.response.authenticatorData,
        signature: credential.response.signature
      },
      null
    )
    if (!out.ok) return out
    return {
      ok: true,
      sub: out.sub,
      dev: found.device.id,
      token: this.mint(out.sub, scope, { aud: audience.aud, dev: found.device.id })
    }
  }

  /**
   * A scope that names one thing must name it well. `call` is confined to a
   * door and `link` to a single device id; every other scope has no audience,
   * and one supplied is dropped rather than carried.
   */
  private checkAudience(
    scope: TokenScope,
    aud?: string
  ): { ok: true; aud?: string } | { ok: false; reason: 'bad_audience' } {
    if (scope === 'call') {
      return typeof aud === 'string' && AUDIENCE.test(aud)
        ? { ok: true, aud }
        : { ok: false, reason: 'bad_audience' }
    }
    if (scope === 'link') {
      return typeof aud === 'string' && DEVICE_AUDIENCE.test(aud)
        ? { ok: true, aud: aud.toLowerCase() }
        : { ok: false, reason: 'bad_audience' }
    }
    return { ok: true }
  }

  /** Mint a token for a device this server has ALREADY authenticated. */
  mintFor(sub: string, dev: string, scope: TokenScope, aud?: string): string | null {
    const audience = this.checkAudience(scope, aud)
    if (!audience.ok) return null
    return this.mint(sub, scope, { aud: audience.aud, dev })
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

  /** The relying party this registry is — what a page must build a ceremony for. */
  rp(): { id: string; origin: string } {
    return { id: this.config.rpId, origin: this.config.origin }
  }

  /**
   * Consume a challenge this server issued for a REGISTRATION ceremony. The
   * login path spends nonces inside `verifyCeremony`; enrolling a passkey is
   * the other ceremony, and it must spend one too or a captured
   * `attestationObject` could be enrolled twice.
   */
  spendChallenge(challenge: unknown): boolean {
    if (typeof challenge !== 'string') return false
    const entry = this.challenges.get(challenge)
    this.challenges.delete(challenge)
    return entry !== undefined && entry.exp >= this.now() && entry.binding === null
  }

  /**
   * The device ids no token may name any more — published beside the key so a
   * door that verifies offline learns about a revoked laptop on its next
   * refresh instead of at the end of a ten-minute TTL.
   */
  revokedDevices(): string[] {
    return this.accounts.revoked()
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
  ): { ok: true; credentialId: string; dev?: string } | { ok: false; reason: AssertFailure } {
    const out = this.verifyCeremony(this.candidates(input.credentialId), input, expectedBinding)
    if (!out.ok) return out
    return { ok: true, credentialId: out.sub, ...(out.dev === undefined ? {} : { dev: out.dev }) }
  }

  /**
   * EVERY KEY THAT MIGHT SPEAK FOR THIS NAME, in the order they are trusted.
   *
   * An account's unrevoked devices come first: after the migration that is
   * where every handle lives, and it is what makes one name work from four
   * machines. The legacy flat credential map is kept as a fallback for the one
   * release the design allots it — a credential whose id is not handle-shaped
   * never became an account, and refusing it here would log somebody out for a
   * reason they could not act on.
   */
  private candidates(credentialId: string): Candidate[] {
    const handle = typeof credentialId === 'string' ? credentialId.toLowerCase() : ''
    const devices = this.accounts
      .active(handle)
      // A passkey answers the WebAuthn path, where the authenticator names its
      // own credential id; it is not a key for the handle-shaped ceremony.
      .filter((device: Device) => device.kind !== 'passkey')
      .map((device: Device) => ({ sub: handle, dev: device.id, jwk: device.jwk }))
    const legacy = this.credentials
      .filter((c) => c.credentialId === credentialId)
      .map((c) => ({ sub: c.credentialId, jwk: c.jwk }))
    return [...devices, ...legacy]
  }

  /**
   * The one WebAuthn verification. Every check but the signature is made once,
   * against the server's own record; only the signature is tried against each
   * candidate key, because an account with four devices is four keys and one
   * ceremony rather than four ceremonies.
   */
  private verifyCeremony(
    candidates: readonly Candidate[],
    input: { clientDataJSON: string; authenticatorData: string; signature: string },
    expectedBinding: string | null
  ): { ok: true; sub: string; dev?: string } | { ok: false; reason: AssertFailure } {
    if (candidates.length === 0) return { ok: false, reason: 'unknown_credential' }
    if (
      typeof input.clientDataJSON !== 'string' ||
      typeof input.authenticatorData !== 'string' ||
      typeof input.signature !== 'string'
    ) {
      return { ok: false, reason: 'bad_signature' }
    }

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
    for (const candidate of candidates) {
      let good = false
      try {
        const { key, hash } = keyFor(candidate.jwk)
        good = verify(hash, signed, key, fromB64url(input.signature))
      } catch {
        good = false
      }
      if (good) {
        return {
          ok: true,
          sub: candidate.sub,
          ...(candidate.dev === undefined ? {} : { dev: candidate.dev })
        }
      }
    }
    return { ok: false, reason: 'bad_signature' }
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

  private mint(sub: string, scope: TokenScope, options: { aud?: string; dev?: string } = {}): string {
    // A link token lives two minutes and carries a jti, because it is spent
    // once. Everything else is the ten-minute retry ticket it always was.
    const ttl = scope === 'link' ? this.config.linkTtlMs ?? 2 * 60 * 1000 : this.config.tokenTtlMs
    const claims: TokenClaims = {
      sub,
      ...(options.dev === undefined ? {} : { dev: options.dev }),
      scope,
      exp: this.now() + ttl,
      ...(options.aud === undefined ? {} : { aud: options.aud }),
      ...(scope === 'link' ? { jti: b64url(randomBytes(16)) } : {})
    }
    const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'))
    const signature = sign(null, Buffer.from(body, 'utf8'), this.keys().privateKey)
    return `${body}.${b64url(signature)}`
  }

  /**
   * SPEND a link token: verify it and refuse the second presentation.
   *
   * Single use is the difference between "this device may be vouched for" and
   * "this device may be vouched for repeatedly by anyone who saw the request".
   */
  spendLink(token: string, deviceId: string): TokenClaims | null {
    const claims = this.verifyToken(token)
    if (claims === null || claims.scope !== 'link') return null
    if (typeof claims.jti !== 'string') return null
    if (claims.aud !== deviceId.toLowerCase()) return null
    if (this.spentJti.has(claims.jti)) return null
    this.spentJti.set(claims.jti, claims.exp)
    // A spent id is worthless once the token it names has expired.
    for (const [jti, exp] of this.spentJti) {
      if (exp < this.now()) this.spentJti.delete(jti)
    }
    return claims
  }

  /**
   * Claims for a token, or null. Null for malformed, mis-signed and expired
   * alike — a caller must not be able to tell those apart and act differently.
   */
  verifyToken(token: string): TokenClaims | null {
    try {
      const parts = token.split('.')
      if (parts.length !== 2) return null
      const [body, signature] = parts
      if (!body || !signature) return null
      if (!verify(null, Buffer.from(body, 'utf8'), this.keys().publicKey, fromB64url(signature))) {
        return null
      }
      const claims = JSON.parse(fromB64url(body).toString('utf8')) as TokenClaims
      if (typeof claims.sub !== 'string' || claims.sub === '') return null
      if (typeof claims.exp !== 'number' || claims.exp < this.now()) return null
      if (!SCOPES.includes(claims.scope)) return null
      if (claims.scope === 'call' && (typeof claims.aud !== 'string' || !AUDIENCE.test(claims.aud))) return null
      if (claims.scope === 'link' && (typeof claims.aud !== 'string' || !DEVICE_AUDIENCE.test(claims.aud))) return null
      // REVOCATION, before expiry. A token names the device that signed for it,
      // and a device dropped from its account stops being able to act the
      // moment it is dropped rather than ten minutes later.
      if (typeof claims.dev === 'string' && this.accounts.isRevoked(claims.dev)) return null
      return claims
    } catch {
      return null
    }
  }
}
