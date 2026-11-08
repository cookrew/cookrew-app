import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import {
  AUTH_CODE_TTL_MS,
  AUTH_POLL_MS,
  AUTH_REQUEST_TTL_MS,
  USER_CODE_ALPHABET,
  normaliseUserCode,
  type AuthClient,
  type AuthDevice,
  type AuthIntent
} from '../../src/shared/auth-site'
import type { OAuthBack, ProviderId } from '../../src/shared/oauth'
import { deviceSigned, deviceTransactionTranscript, readDevicePayload, type DevicePayload } from './auth-device-transaction'
import type { ProviderProof } from './v2-oauth-providers'

/**
 * AUTH REQUESTS — ONE SIGN-IN, FROM THE CLIENT THAT ASKED TO THE CODE IT SPENDS.
 *
 * In memory for the reason v2-pending.ts gives: a sign-in in flight is a fact
 * about a conversation, and a restart ending every one of them is correct.
 *
 * THE DEVICE IS FIXED BEFORE ANYBODY AUTHENTICATES. A request is opened with
 * the public key the session will belong to, and it is not usable until that
 * key has signed the request's transcript. Nothing after that may name a
 * device: every rung on the auth page reads it from here.
 *
 * FOUR SECRETS, FOUR JOBS.
 *   `id`        names the request. A desktop's browser sees it in the URL, so
 *               alone it is worth nothing: the first browser to claim it is
 *               the only one that may act on it.
 *   binding     that browser's random cookie, held here as a hash.
 *   challenge   the client's PKCE challenge: only the process holding the
 *               verifier can spend the result.
 *   code        the one-use result, held as a hash, two minutes long, burned
 *               on its first presentation whatever the verifier was.
 *
 * Every lookup that fails reads as gone; a caller is never told which check
 * refused.
 */

const REQUESTS_MAX = 1000
/**
 * A REQUEST NOBODY HAS PROVEN IS WORTH A MINUTE. A client proves its key the
 * moment it opens one, so an unproven request is either in that moment or
 * litter; it must not hold a slot for ten minutes.
 */
const UNPROVEN_TTL_MS = 60 * 1000
/** Open requests one address may hold at once; a flood from one place fills only its own. */
const PER_ADDRESS_MAX = 10
/** A terminal's wrong verifier this many times and its request is dropped. */
const FAILURES_MAX = 5

export interface AuthOpener {
  username: string
  jti: string
  device: string
}

export interface AuthResult {
  status: number
  body: Record<string, unknown>
}

export interface AuthRequest {
  readonly id: string
  readonly client: AuthClient
  readonly intent: AuthIntent
  readonly provider: ProviderId | null
  /** The payload every /v2 sign-in sends, kept as sent: the account store is its judge. */
  readonly device: AuthDevice
  readonly payload: DevicePayload
  readonly transcript: string
  readonly challenge: string
  readonly clientState: string | null
  readonly back: OAuthBack | null
  readonly returnPath: string | null
  readonly usernameHint: string | null
  readonly userCode: string | null
  readonly opener: AuthOpener | null
  /** Who opened it, for the per-address cap. Never shown, never logged. */
  readonly address: string
  readonly createdAt: number
  readonly expiresAt: number
  proven: boolean
  binding: string | null
  stage: 'open' | 'provider' | 'done' | 'denied'
  deniedWhy: 'denied' | 'expired' | null
  proof: ProviderProof | null
  /**
   * A LINK WAITING FOR ITS OPENER. The provider proved an identity for a link
   * request, and it is written to the account only when the client that opened
   * the request spends the code — with the verifier and the opener's session —
   * never because some browser finished the page.
   */
  linkProof: ProviderProof | null
  result: AuthResult | null
  codeHash: string | null
  codeExpiresAt: number
  nextPollAt: number
  failures: number
}

export interface OpenInput {
  client: AuthClient
  intent: AuthIntent
  provider: ProviderId | null
  device: AuthDevice
  challenge: string
  clientState: string | null
  back: OAuthBack | null
  returnPath: string | null
  usernameHint: string | null
  opener: AuthOpener | null
  address: string
}

const token = (): string => randomBytes(32).toString('base64url')
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('base64url')

function same(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** The S256 challenge of a verifier matches, without a timing edge. */
export function verifierMatches(challenge: string, verifier: unknown): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  return same(digest(verifier), challenge)
}

function userCode(): string {
  const letters = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)])
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`
}

export class AuthRequests {
  private readonly now: () => number
  private readonly held = new Map<string, AuthRequest>()
  private readonly byCode = new Map<string, string>()
  private readonly byUserCode = new Map<string, string>()

  constructor(
    private readonly audience: string,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /** A new request, or null when the device is not a usable key or the store is full. */
  open(input: OpenInput): AuthRequest | 'invalid' | 'capacity' {
    const at = this.now()
    this.sweep(at)
    const payload = readDevicePayload({ publicKeyJwk: input.device.jwk, deviceId: input.device.id, name: input.device.name })
    if (payload === null) return 'invalid'
    const mine = [...this.held.values()].filter((held) => held.address === input.address)
    if (mine.length >= PER_ADDRESS_MAX) return 'capacity'
    // FULL MEANS THE OLDEST UNPROVEN GOES, never "everyone is refused": a
    // stranger filling the store with requests they never prove must not stop
    // anybody else from signing in.
    if (this.held.size >= REQUESTS_MAX) {
      const oldest = [...this.held.values()].filter((held) => !held.proven).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest === undefined) return 'capacity'
      this.drop(oldest)
    }
    let id = token()
    while (this.held.has(id)) id = token()
    const expiresAt = at + AUTH_REQUEST_TTL_MS
    // The transcript names the auth origin, this request and a fresh challenge,
    // so a signature made for anything else — a hello, a reach card — is not one.
    const transcript = deviceTransactionTranscript({ audience: this.audience, transactionId: id, challenge: token(), expiresAt, device: payload })
    let code: string | null = null
    if (input.client === 'cli') {
      code = userCode()
      while (this.byUserCode.has(code)) code = userCode()
    }
    const request: AuthRequest = {
      id,
      client: input.client,
      intent: input.intent,
      provider: input.provider,
      device: input.device,
      payload,
      transcript,
      challenge: input.challenge,
      clientState: input.clientState,
      back: input.back,
      returnPath: input.returnPath,
      usernameHint: input.usernameHint,
      userCode: code,
      opener: input.opener,
      address: input.address,
      createdAt: at,
      expiresAt,
      proven: false,
      binding: null,
      stage: 'open',
      deniedWhy: null,
      proof: null,
      linkProof: null,
      result: null,
      codeHash: null,
      codeExpiresAt: 0,
      nextPollAt: 0,
      failures: 0
    }
    this.held.set(id, request)
    if (code !== null) this.byUserCode.set(code, id)
    return request
  }

  /** The device's signature over the transcript. A bad one ends the request: an honest key never makes one. */
  prove(id: unknown, signature: unknown): 'ok' | 'gone' | 'bad_proof' {
    const request = this.live(id)
    if (request === null) return 'gone'
    if (request.proven) return 'ok'
    if (!deviceSigned(request.payload, request.transcript, signature)) {
      this.drop(request)
      return 'bad_proof'
    }
    request.proven = true
    return 'ok'
  }

  /** A live, proven request, or null. */
  get(id: unknown): AuthRequest | null {
    const request = this.live(id)
    return request !== null && request.proven ? request : null
  }

  /** The request a terminal's short code names, or null. */
  byUser(raw: unknown): AuthRequest | null {
    const code = normaliseUserCode(raw)
    if (code === null) return null
    const id = this.byUserCode.get(code)
    return id === undefined ? null : this.get(id)
  }

  /**
   * THE FIRST BROWSER TO ASK IS THE ONE. `secret` is this browser's binding
   * cookie; a request another browser already holds is refused, so a link that
   * leaks after it was opened opens nothing.
   */
  claim(request: AuthRequest, secret: string): boolean {
    const hash = digest(secret)
    if (request.binding === null) {
      request.binding = hash
      return true
    }
    return same(request.binding, hash)
  }

  /**
   * Is this browser the one that claimed it? A miss is refused and nothing
   * more: the id is in a desktop's URL, so a miss counting towards a drop
   * would let anybody holding the link end somebody else's sign-in.
   */
  bound(id: unknown, secret: string | null): AuthRequest | null {
    const request = this.get(id)
    if (request === null || secret === null || request.binding === null) return null
    return same(request.binding, digest(secret)) ? request : null
  }

  /** Still waiting for the person: neither finished nor refused. */
  isOpen(request: AuthRequest): boolean {
    return (request.stage === 'open' || request.stage === 'provider') && this.held.get(request.id) === request
  }

  /** The request a cookie names, whatever its stage, for the way back alone. */
  peek(id: unknown): AuthRequest | null {
    if (typeof id !== 'string') return null
    return this.held.get(id) ?? null
  }

  /** A provider answered for this request; the bound browser continues it. */
  stashProof(request: AuthRequest, proof: ProviderProof): void {
    request.proof = proof
    request.stage = 'provider'
  }

  takeProof(request: AuthRequest): ProviderProof | null {
    const proof = request.proof
    request.proof = null
    if (request.stage === 'provider') request.stage = 'open'
    return proof
  }

  /**
   * THE PERSON IS THROUGH. The result is held for the client and nothing else
   * travels: a desktop and the web get a one-use code, a terminal polls.
   */
  complete(request: AuthRequest, result: AuthResult, ttlMs: number = AUTH_CODE_TTL_MS, linkProof: ProviderProof | null = null): string | null {
    const at = this.now()
    request.stage = 'done'
    request.result = result
    request.proof = null
    request.linkProof = linkProof
    // A code shown behind recovery codes may wait while they are saved, but
    // never past the request itself: a client waits for exactly that long.
    request.codeExpiresAt = at + Math.max(AUTH_CODE_TTL_MS, Math.min(ttlMs, request.expiresAt - at))
    if (request.client === 'cli') return null
    const code = token()
    request.codeHash = digest(code)
    this.byCode.set(request.codeHash, request.id)
    return code
  }

  /** The person said no, or the provider did. The client is told once and the request is over. */
  deny(request: AuthRequest, why: 'denied' | 'expired' = 'denied'): void {
    request.stage = 'denied'
    request.deniedWhy = why
    request.proof = null
    request.codeExpiresAt = this.now() + AUTH_CODE_TTL_MS
  }

  /**
   * SPEND A CODE. Burned on the first presentation whatever the verifier was:
   * a wrong verifier is somebody who caught the link and not the client, and
   * the real client can start again where a thief must not get a second go.
   */
  redeem(code: unknown, client: AuthClient, verifier: unknown): { request: AuthRequest; result: AuthResult } | null {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null
    const id = this.byCode.get(digest(code))
    const request = id === undefined ? undefined : this.held.get(id)
    if (request === undefined || request.result === null) return null
    this.drop(request)
    if (this.now() >= request.codeExpiresAt || request.client !== client) return null
    if (!verifierMatches(request.challenge, verifier)) return null
    return { request, result: request.result }
  }

  /**
   * A TERMINAL ASKS WHETHER IT IS DONE. Paced here whoever is asking; a wrong
   * verifier counts towards the drop but does not end a flow a person is
   * halfway through.
   */
  poll(id: unknown, verifier: unknown):
    | { state: 'pending'; intervalMs: number }
    | { state: 'slow'; intervalMs: number }
    | { state: 'done'; result: AuthResult }
    | { state: 'over'; why: 'denied' | 'expired' }
    | { state: 'gone' } {
    const request = typeof id === 'string' ? this.held.get(id) : undefined
    if (request === undefined || request.client !== 'cli' || !request.proven) return { state: 'gone' }
    if (!verifierMatches(request.challenge, verifier)) {
      this.fail(request)
      return { state: 'gone' }
    }
    const at = this.now()
    if (request.stage === 'denied') {
      this.drop(request)
      return { state: 'over', why: request.deniedWhy ?? 'denied' }
    }
    if (request.stage === 'done' && request.result !== null) {
      this.drop(request)
      return at < request.codeExpiresAt ? { state: 'done', result: request.result } : { state: 'over', why: 'expired' }
    }
    if (at >= request.expiresAt) {
      this.drop(request)
      return { state: 'over', why: 'expired' }
    }
    if (at < request.nextPollAt) return { state: 'slow', intervalMs: AUTH_POLL_MS }
    request.nextPollAt = at + AUTH_POLL_MS
    return { state: 'pending', intervalMs: AUTH_POLL_MS }
  }

  /** For a test: the interval is a real five seconds, and a test cannot wait it out. */
  allowPollNow(id: string): void {
    const request = this.held.get(id)
    if (request !== undefined) request.nextPollAt = 0
  }

  /** When this request stops being anything at all. */
  private until(request: AuthRequest): number {
    // A finished request stays readable until its code goes cold, so a page
    // reloaded on the handoff screen still shows it rather than "expired".
    if (request.stage === 'done' || request.stage === 'denied') return request.codeExpiresAt
    return request.proven ? request.expiresAt : request.createdAt + UNPROVEN_TTL_MS
  }

  private live(id: unknown): AuthRequest | null {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null
    const request = this.held.get(id)
    if (request === undefined) return null
    if (this.now() >= this.until(request)) {
      this.drop(request)
      return null
    }
    return request
  }

  private fail(request: AuthRequest): void {
    request.failures += 1
    if (request.failures >= FAILURES_MAX) this.drop(request)
  }

  private drop(request: AuthRequest): void {
    if (this.held.get(request.id) !== request) return
    this.held.delete(request.id)
    if (request.codeHash !== null) this.byCode.delete(request.codeHash)
    if (request.userCode !== null) this.byUserCode.delete(request.userCode)
  }

  private sweep(at: number): void {
    for (const request of [...this.held.values()]) if (at >= this.until(request)) this.drop(request)
  }
}
