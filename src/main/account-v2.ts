import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_LOCK_AFTER_MS,
  MIN_PASSWORD,
  RESERVED_PREFIXES,
  normaliseUsername,
  usernameProblem,
  type AccountDevice,
  type AccountProfile,
  type AccountRefusal,
  type AccountResult,
  type UsernameCheck,
} from '../shared/account-v2'

export { DEFAULT_LOCK_AFTER_MS }

/**
 * THE ONE ACCOUNT FILE, and the calls that fill it.
 *
 * ~/.cookrew/account.json, 0600, written temp-and-rename. One file because
 * there is one account (architecture P2: a person is an account) and because
 * a second file is a second answer to "who is this Mac" that can disagree
 * with the first — which is the failure the v1 work actually shipped.
 *
 * WHAT IS IN IT AND WHAT IS NOT. The device's key pair, the session token the
 * registry minted, and a LOCAL unlock verifier. Not the password: the password
 * goes to cookrew.dev and nowhere else (architecture, security model line 1).
 * The verifier is scrypt over the password with a per-install salt, and it can
 * do exactly one thing — say yes or no to the same password, offline, so the
 * app can be locked and unlocked on a plane (D5).
 *
 * NOTHING HERE BLOCKS A LOCAL-ONLY DESKTOP. No file means no account, and P4
 * says that is a complete, supported state — every function below answers
 * `no_account` rather than throwing, so a caller that never claims never sees
 * an error path.
 */

/**
 * The reserved-prefix refusal, in the owner's voice.
 *
 * Exported so the renderer's copy table can carry the same words rather than a
 * second wording of the same rule.
 */
export const RESERVED_SENTENCE = (username: string): string =>
  `${RESERVED_PREFIXES.find((prefix) => username.startsWith(prefix)) ?? 'That prefix'} is reserved for the doors — pick another name.`

/** Where the account lives. `base` exists so tests never touch a real home. */
export function accountFilePath(base?: string): string {
  return path.join(base ?? path.join(homedir(), '.cookrew'), 'account.json')
}

/** The registry this app talks to. Overridable for a test deployment. */
export function registryOrigin(): string {
  return process.env.COOKREW_REGISTRY || 'https://cookrew.dev'
}

/** A session token and the moment it stops being one, in epoch ms. */
export interface AccountSession {
  token: string
  exp: number
}

/** Offline unlock: scrypt over the password, salt and hash both base64url. */
export interface UnlockVerifier {
  salt: string
  hash: string
}

export interface AccountFile {
  username: string
  deviceId: string
  kind: 'desktop'
  /** This Mac's name, as the Devices tab lists it. */
  name: string
  privateKeyJwk: Record<string, unknown>
  publicKeyJwk: Record<string, unknown>
  /** The origin the account was claimed at; a key must not follow the owner. */
  registry: string
  session: AccountSession | null
  unlock: UnlockVerifier
  lockAfterMs: number
  claimedAt: number
  /** May cookrew.dev offer this Mac's workspaces to the account's phones? */
  workspacesReachable: boolean
  /**
   * When the owner said they had saved their recovery codes, or null.
   *
   * LOCAL by necessity: cookrew.dev cannot know whether eight codes were
   * written down. Kept in this file rather than in a setting so it travels
   * with the account it is about — a reset account has not saved anything.
   */
  recoveryCodesSavedAt: number | null
}

/** scrypt cost. Node's default N=16384; stated so a re-derive cannot drift. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 } as const
/** Treat a session this close to expiry as already gone, so the ask is early. */
const SESSION_SKEW_MS = 60_000

function deriveUnlock(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }).toString('base64url')
}

/** A fresh verifier for a password. The password itself is never kept. */
export function unlockVerifierFor(password: string): UnlockVerifier {
  const salt = randomBytes(16).toString('base64url')
  return { salt, hash: deriveUnlock(password, salt) }
}

/** Constant-time check of a password against a stored verifier. */
export function matchesUnlock(verifier: UnlockVerifier, password: string): boolean {
  const candidate = Buffer.from(deriveUnlock(password, verifier.salt))
  const stored = Buffer.from(verifier.hash)
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}

/**
 * The device id, as a PURE FUNCTION OF THE KEY.
 *
 * Derived, not minted, so the id cannot drift from the key it names: a
 * half-written file, a restore from backup, or a second process racing the
 * first all recompute the same id from the same public key instead of
 * inventing a second identity for one device.
 *
 * The input is the RFC 7638 JWK thumbprint — the canonical member subset in
 * lexicographic order, exactly as every other implementation computes it — so
 * the registry can check the id belongs to the key it was sent with. UUID
 * SHAPE because the wire says uuid and because everything downstream (logs,
 * the Devices tab, a URL) already knows how to carry one; version 8 is the
 * RFC 9562 slot for exactly this, a UUID whose bits come from somewhere else.
 */
export function deviceIdFor(publicKeyJwk: Record<string, unknown>): string {
  const canonical = JSON.stringify({
    crv: publicKeyJwk.crv,
    kty: publicKeyJwk.kty,
    x: publicKeyJwk.x,
  })
  const thumbprint = createHash('sha256').update(canonical).digest()
  const bytes = Buffer.from(createHash('sha256').update(thumbprint).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x80 // version 8: custom
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10: RFC 9562
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** A new Ed25519 device key, as the pair of JWKs the file stores. */
export function mintDeviceKey(): {
  privateKeyJwk: Record<string, unknown>
  publicKeyJwk: Record<string, unknown>
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyJwk: privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
    publicKeyJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  }
}

function looksLikeAccount(value: unknown): value is AccountFile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.username === 'string' &&
    typeof record.deviceId === 'string' &&
    typeof record.privateKeyJwk === 'object' &&
    record.privateKeyJwk !== null &&
    typeof record.unlock === 'object' &&
    record.unlock !== null
  )
}

/**
 * Read the account, or null.
 *
 * A file that cannot be parsed reads as NO ACCOUNT, not as an error: the app
 * is fully usable without one (P4), so the worst a corrupt file may do is put
 * the owner back in front of the claim sheet — never refuse to boot.
 */
export function loadAccount(base?: string): AccountFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountFilePath(base), 'utf8'))
    if (!looksLikeAccount(parsed)) return null
    return {
      ...parsed,
      workspacesReachable: parsed.workspacesReachable !== false,
      recoveryCodesSavedAt: parsed.recoveryCodesSavedAt ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Publish the account file: 0600, temp-and-rename.
 *
 * Atomic because the file holds the device's PRIVATE KEY beside the id derived
 * from it. A torn write is not a lost setting; it is a Mac that can no longer
 * prove it is the device the registry knows.
 */
export function writeAccount(account: AccountFile, base?: string): void {
  const file = accountFilePath(base)
  const temp = `${file}.tmp`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(temp, `${JSON.stringify(account, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(temp, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  chmodSync(file, 0o600)
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AccountsDeps {
  /** Directory holding account.json. Defaults to ~/.cookrew. */
  base?: string
  /** Injected so tests never open a socket. */
  fetch?: FetchLike
  now?: () => number
  origin?: string
  /** This Mac's name, for the Devices tab. */
  deviceName?: string
}

interface WireError {
  error?: string
  message?: string
}

const REFUSALS: Record<string, AccountRefusal> = {
  taken: 'taken',
  bad_username: 'bad_username',
  weak_password: 'weak_password',
  bad_device: 'bad_device',
  bad_credentials: 'bad_credentials',
  last_device: 'last_device',
}

async function wireError(
  response: Response,
): Promise<{ reason: AccountRefusal; message?: string }> {
  if (response.status === 429) return { reason: 'rate_limited' }
  if (response.status === 401) return { reason: 'session-expired' }
  let body: WireError = {}
  try {
    body = (await response.json()) as WireError
  } catch {
    // A refusal with no body is still a refusal; it just has no sentence.
  }
  const reason: AccountRefusal =
    (typeof body.error === 'string' ? REFUSALS[body.error] : undefined) ?? 'unknown'
  return body.message ? { reason, message: body.message } : { reason }
}

/**
 * The account, as the rest of main uses it.
 *
 * Every method answers an `AccountResult` and none of them throw: a registry
 * that is down must leave a local desktop working, so "cookrew.dev did not
 * answer" is a value, never an exception that unwinds into a boot path.
 */
export class Accounts {
  private readonly base: string | undefined
  private readonly http: FetchLike
  private readonly now: () => number
  private readonly origin: string
  private readonly deviceName: string
  private cached: AccountFile | null
  /** The last minted batch, in memory only — never written, never logged. */
  private freshCodes: readonly string[] | null = null

  constructor(deps: AccountsDeps = {}) {
    this.base = deps.base
    this.http = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? (() => Date.now())
    this.origin = deps.origin ?? registryOrigin()
    this.deviceName = deps.deviceName ?? 'This Mac'
    this.cached = loadAccount(deps.base)
  }

  /** The account file as it stands, or null for a local-only desktop. */
  account(): AccountFile | null {
    return this.cached
  }

  private save(next: AccountFile): AccountFile {
    writeAccount(next, this.base)
    this.cached = next
    return next
  }

  /**
   * Is this name free? NEVER OPTIMISTICALLY.
   *
   * A check that guesses "free" when the registry is silent produces a claim
   * sheet whose primary is enabled and whose submission is refused — the one
   * outcome the sheet exists to prevent. Silence is `unknown` and the sheet
   * says so in the registry-down sentence.
   */
  async checkUsername(raw: string): Promise<UsernameCheck> {
    const username = normaliseUsername(raw)
    const problem = usernameProblem(username)
    if (problem === 'shape') return 'invalid'
    // Refused HERE, and named. The registry answers `bad_username` for a
    // reserved prefix, which the sheet would otherwise render as the
    // lowercase-and-dashes sentence about a name that is already lowercase.
    if (problem === 'reserved') return 'reserved'
    try {
      const response = await this.http(
        `${this.origin}/v2/accounts/${encodeURIComponent(username)}`,
        { method: 'HEAD' },
      )
      if (response.status === 200) return 'taken'
      if (response.status === 404) return 'free'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Claim the name, and become the account's first device.
   *
   * THE FILE IS WRITTEN ONLY ON 201. Anything else — taken, weak, throttled,
   * a socket that never answered — leaves the desktop exactly as local as it
   * was. A file written ahead of the registry's answer is an app that believes
   * it owns a name somebody else holds.
   */
  async claim(input: {
    username: string
    password: string
    name?: string
  }): Promise<AccountResult<AccountFile>> {
    const username = normaliseUsername(input.username)
    const problem = usernameProblem(username)
    if (problem === 'reserved') {
      // The message is carried so the surface says the REAL reason; the reason
      // stays `bad_username` because that is what the registry would answer.
      return { ok: false, reason: 'bad_username', message: RESERVED_SENTENCE(username) }
    }
    if (problem === 'shape') return { ok: false, reason: 'bad_username' }
    if (input.password.length < MIN_PASSWORD) return { ok: false, reason: 'weak_password' }

    const { privateKeyJwk, publicKeyJwk } = mintDeviceKey()
    const deviceId = deviceIdFor(publicKeyJwk)
    const name = input.name?.trim() || this.deviceName
    let response: Response
    try {
      response = await this.http(`${this.origin}/v2/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password: input.password,
          device: { id: deviceId, kind: 'desktop', name, jwk: publicKeyJwk },
        }),
      })
    } catch {
      return { ok: false, reason: 'offline' }
    }
    if (response.status !== 201) return { ok: false, ...(await wireError(response)) }

    let body: { username?: string; deviceId?: string; session?: AccountSession }
    try {
      body = (await response.json()) as typeof body
    } catch {
      return { ok: false, reason: 'unknown' }
    }
    const session = body.session ?? null
    return {
      ok: true,
      value: this.save({
        username: body.username ?? username,
        // The registry names the device it filed; ours is derived from the key
        // it was sent, so the two agree — but its answer is the record.
        deviceId: body.deviceId ?? deviceId,
        kind: 'desktop',
        name,
        privateKeyJwk,
        publicKeyJwk,
        registry: this.origin,
        session,
        unlock: unlockVerifierFor(input.password),
        lockAfterMs: DEFAULT_LOCK_AFTER_MS,
        claimedAt: this.now(),
        workspacesReachable: true,
        recoveryCodesSavedAt: null,
      }),
    }
  }

  /** Does this password unlock the app? Offline, and the only use of it. */
  verifyUnlock(password: string): boolean {
    const account = this.cached
    if (!account) return false
    return matchesUnlock(account.unlock, password)
  }

  /** Is the session usable right now? Expiry is judged with a minute of skew. */
  sessionLive(): boolean {
    const session = this.cached?.session
    return session !== null && session !== undefined && session.exp - SESSION_SKEW_MS > this.now()
  }

  /**
   * Trade the password for a new session.
   *
   * There is no refresh token by design: the session is the only bearer this
   * app holds, so a silent renewal would mean a credential that never expires
   * living in a file. When it dies, the person is asked once — which is what
   * `session-expired` sends every surface to do.
   */
  async resume(password: string): Promise<AccountResult<AccountSession>> {
    const account = this.cached
    if (!account) return { ok: false, reason: 'no_account' }
    let response: Response
    try {
      response = await this.http(`${this.origin}/v2/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: account.username,
          password,
          device: {
            id: account.deviceId,
            kind: 'desktop',
            name: account.name,
            jwk: account.publicKeyJwk,
          },
        }),
      })
    } catch {
      return { ok: false, reason: 'offline' }
    }
    if (response.status !== 201) return { ok: false, ...(await wireError(response)) }
    let body: { token?: string; exp?: number }
    try {
      body = (await response.json()) as typeof body
    } catch {
      return { ok: false, reason: 'unknown' }
    }
    if (typeof body.token !== 'string' || typeof body.exp !== 'number') {
      return { ok: false, reason: 'unknown' }
    }
    const session = { token: body.token, exp: body.exp }
    this.save({ ...account, session })
    return { ok: true, value: session }
  }

  /** One authenticated call, with the session checked before the socket. */
  private async authed<T>(
    pathname: string,
    init: RequestInit & { parse?: boolean } = {},
  ): Promise<AccountResult<T>> {
    const account = this.cached
    if (!account) return { ok: false, reason: 'no_account' }
    if (!this.sessionLive()) return { ok: false, reason: 'session-expired' }
    const { parse = true, ...rest } = init
    let response: Response
    try {
      response = await this.http(`${this.origin}${pathname}`, {
        ...rest,
        headers: {
          ...(rest.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(rest.headers as Record<string, string> | undefined),
          authorization: `Bearer ${account.session?.token ?? ''}`,
        },
      })
    } catch {
      return { ok: false, reason: 'offline' }
    }
    if (!response.ok) return { ok: false, ...(await wireError(response)) }
    if (!parse || response.status === 204) return { ok: true, value: undefined as T }
    try {
      return { ok: true, value: (await response.json()) as T }
    } catch {
      return { ok: false, reason: 'unknown' }
    }
  }

  /** The whole profile: who, which devices, which desktops (D4). */
  profile(): Promise<AccountResult<AccountProfile>> {
    return this.authed<AccountProfile>('/v2/me')
  }

  /** Just the devices — what the Devices tab redraws after a revoke. */
  async devices(): Promise<AccountResult<readonly AccountDevice[]>> {
    const result = await this.profile()
    return result.ok ? { ok: true, value: result.value.devices } : result
  }

  setProfile(patch: {
    displayName?: string
    avatar?: string | null
  }): Promise<AccountResult<AccountProfile>> {
    return this.authed<AccountProfile>('/v2/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  /** The last device cannot be revoked — the registry answers 409 last_device. */
  revokeDevice(id: string): Promise<AccountResult<void>> {
    return this.authed<void>(`/v2/me/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      parse: false,
    })
  }

  /**
   * Eight codes, shown once (D3). Never logged, here or anywhere.
   *
   * The batch is held IN MEMORY so SAVE AS FILE can write it without the
   * renderer handing the codes back over the bridge — a channel that took
   * arbitrary text and a path is a channel that writes chosen bytes wherever
   * the owner clicks. It reaches disk only through that save, and it dies with
   * the process.
   */
  async recoveryCodes(): Promise<AccountResult<readonly string[]>> {
    const result = await this.authed<{ codes?: readonly string[] }>('/v2/me/recovery-codes', {
      method: 'POST',
    })
    if (!result.ok) return result
    const codes = result.value.codes
    if (!Array.isArray(codes)) return { ok: false, reason: 'unknown' }
    this.freshCodes = codes
    return { ok: true, value: codes }
  }

  /** The batch just minted, for the save dialog. Null once it is put away. */
  pendingRecoveryCodes(): readonly string[] | null {
    return this.freshCodes
  }

  /**
   * The owner says the codes are safe.
   *
   * Recorded locally and the in-memory batch dropped, so the RESCUE row stops
   * saying NOT SAVED about something that was saved — the one fact this card
   * exists to track, and the one it was getting wrong.
   */
  markRecoveryCodesSaved(at?: number): number | null {
    const account = this.cached
    this.freshCodes = null
    if (!account) return null
    const saved = at ?? this.now()
    this.save({ ...account, recoveryCodesSavedAt: saved })
    return saved
  }

  /**
   * Change the password at cookrew.dev, then re-derive the local verifier.
   *
   * In that order, and only on success: a verifier updated ahead of the
   * registry would lock the owner out of the app with a password the account
   * no longer has.
   */
  async setPassword(input: { current: string; next: string }): Promise<AccountResult<void>> {
    if (input.next.length < MIN_PASSWORD) return { ok: false, reason: 'weak_password' }
    const result = await this.authed<void>('/v2/me/password', {
      method: 'POST',
      body: JSON.stringify({ current: input.current, next: input.next }),
      parse: false,
    })
    if (!result.ok) return result
    const account = this.cached
    if (account) this.save({ ...account, unlock: unlockVerifierFor(input.next) })
    return { ok: true, value: undefined }
  }

  /**
   * Register this Mac's workspaces by NAME AND ID — never their content (P1).
   *
   * Silently a no-op when the owner has turned reachability off: the toggle in
   * the Workspaces tab is a statement about what cookrew.dev may offer their
   * phone, so honouring it has to happen before the request, not after.
   */
  async registerDesktop(
    workspaces: readonly { id: string; name: string }[],
  ): Promise<AccountResult<void>> {
    const account = this.cached
    if (!account) return { ok: false, reason: 'no_account' }
    const listed = account.workspacesReachable
      ? workspaces.map((w) => ({ id: w.id, name: w.name }))
      : []
    return this.authed<void>(`/v2/me/desktops/${encodeURIComponent(account.deviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: account.name, workspaces: listed }),
      parse: false,
    })
  }

  /** The Workspaces-tab toggle, persisted for Phase 3 to act on. */
  setWorkspacesReachable(on: boolean): boolean {
    const account = this.cached
    if (!account) return false
    this.save({ ...account, workspacesReachable: on })
    return on
  }

  /**
   * ONE AUTHENTICATED CALL, for the modules that came after this one.
   *
   * Approvals (D6) and the factor ladder (D3) are their own modules — they
   * are their own problem, and this file is long enough — but they need the
   * session, which lives here and only here. So they are given the CALL, not
   * the token: nothing outside this class ever holds the bearer, and the
   * expiry check, the refusal mapping and the offline answer stay in one
   * place rather than being re-implemented per feature.
   */
  call<T>(
    pathname: string,
    init: RequestInit & { parse?: boolean } = {},
  ): Promise<AccountResult<T>> {
    return this.authed<T>(pathname, init)
  }

  /** The idle-lock setting, 0 meaning off. Persisted beside the account. */
  setLockAfterMs(ms: number): number {
    const account = this.cached
    if (!account) return ms
    const value = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_LOCK_AFTER_MS
    this.save({ ...account, lockAfterMs: value })
    return value
  }
}
