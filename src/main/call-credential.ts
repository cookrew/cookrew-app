import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { GateIssuer } from '../shared/gate'

/**
 * THE OWNER'S ISSUER (§9, ④ · S1) — credentials for calling an exported agent.
 *
 * OWNER-AS-ISSUER (ruling, 2026-08-22). This app instance mints and verifies
 * its own call credentials. The alternative — verifying registry-signed tokens
 * — would put an online dependency on a registry that is not deployed into
 * every call, including a call between two machines on the same LAN. The
 * registry becomes a SECOND accepted issuer in M3; because the gate takes an
 * issuer as a parameter, that is an addition rather than a migration.
 *
 * A CREDENTIAL NAMES ONE WORKSPACE. This is the difference from the pairing
 * token, and it is the whole reason this file exists. Today there is exactly
 * one pairing token for the whole app, so "this credential may call agents in
 * playground, and only there" cannot even be expressed — which means the
 * off-scope refusal cannot be tested, and an untestable refusal is a refusal
 * nobody should believe. The workspace is inside the signed claims, so a token
 * cannot be re-aimed at another workspace session by moving it to another URL:
 * that is 403 `workspace` (D4/R9), never 401, because re-authenticating cannot
 * fix it and a client must not loop on it.
 *
 * WHAT THIS IS NOT. Not a session store — a token is a signed statement the
 * server checks without remembering anything, so a relaunch does not lock
 * anyone out. Not the pairing token's replacement either: the LAN tier keeps
 * its pairing token, and this gate is an independent AND on top of it. Tiers
 * are distinguished by the credential presented, never by which listener the
 * bytes arrived on — the mobile listener binds 0.0.0.0, so the LAN tier and the
 * internet tier are the same socket and a listener tells you nothing.
 */

/**
 * What a call credential may do. One value today, and it is still a field: a
 * download token from the registry and a call token from an app instance must
 * never be interchangeable, and the scope is what makes that structural rather
 * than accidental.
 */
export type CallScope = 'call'

export interface CallClaims {
  /** Who is calling. The credential id from the ceremony that minted this. */
  sub: string
  scope: CallScope
  /** The ONE workspace session this credential reaches. */
  workspace: string
  exp: number
}

/**
 * Token lifetime. Longer than the registry's ten minutes because this is
 * presented on every turn of a live conversation rather than once per download
 * — but still an hour, not a day: the lifetime is exactly how long a stolen
 * credential keeps working.
 *
 * A conversation deliberately outlives its credential. The fork a call runs
 * against (§10) is bound to the SUBJECT and the conversation, not to the token,
 * so re-asserting mid-conversation resumes the same fork instead of cutting a
 * second version pin.
 */
const TOKEN_TTL_MS = 60 * 60 * 1000

/** Challenge lifetime. A nonce for one ceremony, not a window to work inside. */
const CHALLENGE_TTL_MS = 90 * 1000

const b64url = (buf: Buffer): string => buf.toString('base64url')
const fromB64url = (value: string): Buffer => Buffer.from(value, 'base64url')

export interface CallCredentialOptions {
  /** Where the signing key lives. Defaults beside the rest of the app's state. */
  base?: string
  now?: () => number
  tokenTtlMs?: number
  challengeTtlMs?: number
}

export class CallCredentialService implements GateIssuer<CallClaims> {
  private readonly keyFile: string
  private readonly now: () => number
  private readonly tokenTtlMs: number
  private readonly challengeTtlMs: number
  /** Outstanding nonces. Consumed on first use, swept when they expire. */
  private readonly challenges = new Map<string, number>()
  private signingKey: { publicKey: KeyObject; privateKey: KeyObject } | null = null

  constructor(options: CallCredentialOptions = {}) {
    const base = options.base ?? path.join(homedir(), '.cookrew')
    this.keyFile = path.join(base, 'call-token-key.jwk')
    this.now = options.now ?? Date.now
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS
    this.challengeTtlMs = options.challengeTtlMs ?? CHALLENGE_TTL_MS
  }

  /**
   * The instance's signing key, generated once and persisted.
   *
   * Persisted rather than per-process because a relaunch that invalidated every
   * outstanding credential would read to a caller as the gate randomly
   * demanding re-authentication — and the owner relaunches this app often.
   */
  private keys(): { publicKey: KeyObject; privateKey: KeyObject } {
    if (this.signingKey) return this.signingKey
    if (existsSync(this.keyFile)) {
      const jwk = JSON.parse(readFileSync(this.keyFile, 'utf8')) as Record<string, unknown>
      const privateKey = createPrivateKey({ key: jwk as never, format: 'jwk' })
      this.signingKey = { privateKey, publicKey: createPublicKey(privateKey) }
      return this.signingKey
    }
    const pair = generateKeyPairSync('ed25519')
    mkdirSync(path.dirname(this.keyFile), { recursive: true })
    writeFileSync(this.keyFile, JSON.stringify(pair.privateKey.export({ format: 'jwk' })), {
      mode: 0o600
    })
    this.signingKey = pair
    return pair
  }

  /**
   * Mint a single-use challenge for the call ceremony.
   *
   * Real, not decorative. A 401 is a promise that a ceremony exists and this
   * server can complete it (§2, and the reason A1 refused to answer 401 before
   * identity existed). The route that spends this nonce must therefore mount in
   * the same slice as the first 401 the gate can emit — a challenge nobody can
   * answer is the same lie in a different place.
   */
  challenge(): string {
    const value = b64url(randomBytes(32))
    this.challenges.set(value, this.now() + this.challengeTtlMs)
    for (const [nonce, exp] of this.challenges) {
      if (exp < this.now()) this.challenges.delete(nonce)
    }
    return value
  }

  /**
   * Spend a challenge. True at most once per nonce, and only while it is fresh.
   *
   * Consumed whether or not the caller's proof then verifies, so a captured
   * nonce cannot be retried against a second attempt.
   */
  consumeChallenge(value: string): boolean {
    const exp = this.challenges.get(value)
    this.challenges.delete(value)
    return exp !== undefined && exp >= this.now()
  }

  /**
   * Mint a credential for one subject against ONE workspace session.
   *
   * The workspace id is a required argument with no default. An
   * unscoped-by-omission credential is precisely the shape this file replaces,
   * so there is no way to ask for one.
   */
  mint(sub: string, workspace: string, scope: CallScope = 'call'): string {
    if (sub.length === 0 || workspace.length === 0) {
      throw new Error('a call credential names a subject and a workspace')
    }
    const claims: CallClaims = {
      sub,
      scope,
      workspace,
      exp: this.now() + this.tokenTtlMs
    }
    const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'))
    return `${body}.${b64url(sign(null, Buffer.from(body, 'utf8'), this.keys().privateKey))}`
  }

  /**
   * Claims for a credential, or null.
   *
   * Null for malformed, mis-signed, expired and structurally wrong alike. A
   * caller must not be able to tell those apart, and — more to the point — no
   * code downstream of this may be able to either, because a branch that can
   * distinguish "no credential" from "bad credential" is a branch where one of
   * them can eventually be made to mean "allowed".
   *
   * WHAT IS DELIBERATELY NOT CHECKED HERE: whether the scope and workspace are
   * the RIGHT ones for the resource being addressed. This verifies a credential
   * is genuine and current; the gate's `covers` step decides whether it reaches
   * the thing asked for, and answers 403 with a reason when it does not. Doing
   * it here instead would collapse that 403 into a 401 and make the branch
   * unreachable — the exact bug a reviewer found in the registry at 467bcfd,
   * where the mint side could only ever produce one scope so the refusal could
   * never fire over HTTP.
   */
  verifyToken(token: string): CallClaims | null {
    try {
      const [body, signature] = token.split('.')
      if (!body || !signature) return null
      if (!verify(null, Buffer.from(body, 'utf8'), this.keys().publicKey, fromB64url(signature))) {
        return null
      }
      const claims = JSON.parse(fromB64url(body).toString('utf8')) as CallClaims
      if (
        typeof claims.sub !== 'string' ||
        typeof claims.workspace !== 'string' ||
        typeof claims.scope !== 'string' ||
        typeof claims.exp !== 'number' ||
        claims.sub.length === 0 ||
        claims.workspace.length === 0 ||
        claims.scope.length === 0
      ) {
        return null
      }
      return claims.exp < this.now() ? null : claims
    } catch {
      return null
    }
  }
}
