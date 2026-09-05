import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  hashPassword,
  hashRecoveryCode,
  mintRecoveryCode,
  passwordIsAcceptable,
  recoveryCodeMatches,
  sanitiseJwk,
  verifyPassword,
  type Hashed
} from './v2-secrets'

/**
 * IDENTITY v2 — THE ACCOUNT STORE.
 *
 * A person is an account; a device is a proof of presence (P2). Everything
 * here follows from that: a username is claimed once and never re-minted, a
 * password is the floor under it, and any device can be taken away as long as
 * one is left to take the next one away with.
 *
 * DIRECTORY FACTS ONLY (P1). A desktop registers the NAMES and IDS of its
 * workspaces and nothing else — no canvas, no transcript, no address of a
 * file. Anything a person made lives on the machine they made it on.
 */

export const V2_FILE = 'accounts-v2.json'

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** Reserved: `acct-…` is how a generated identifier reads, not a person. */
const RESERVED_PREFIX = 'acct-'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
/** 64 KB of data URL, which is a picture small enough to sit in a header. */
const AVATAR_MAX = 64 * 1024
const DISPLAY_NAME_MAX = 40
const DEVICE_NAME_MAX = 64
const WORKSPACE_NAME_MAX = 64
const WORKSPACES_MAX = 64
/** Sessions per account. Fifty devices' worth of open tabs, then the oldest goes. */
const SESSIONS_MAX = 50
const REVOKED_MAX = 500
const RECOVERY_CODES = 8

export type DeviceKind = 'desktop' | 'phone' | 'browser'

export interface DeviceInput {
  id: string
  kind: DeviceKind
  name: string
  jwk: Record<string, unknown>
}

export interface V2Device {
  id: string
  kind: DeviceKind
  name: string
  jwk: Record<string, string>
  addedAt: number
  lastSeenAt: number
}

export interface V2Workspace {
  id: string
  name: string
}

export interface V2Desktop {
  deviceId: string
  name: string
  workspaces: readonly V2Workspace[]
  updatedAt: number
}

export interface V2Session {
  jti: string
  dev: string
  issuedAt: number
}

export interface V2Account {
  username: string
  password: Hashed
  displayName: string
  avatar: string | null
  claimedAt: number
  devices: readonly V2Device[]
  desktops: readonly V2Desktop[]
  sessions: readonly V2Session[]
  recovery: readonly Hashed[]
}

interface Persisted {
  version: 2
  accounts: V2Account[]
  revoked: { id: string; at: number }[]
}

export type CreateRefusal = 'taken' | 'bad_username' | 'weak_password' | 'bad_device'
export type Refused<R extends string> = { ok: false; reason: R }
export type Attached = { ok: true; account: V2Account; device: V2Device }

export class V2Accounts {
  private readonly file: string
  private readonly now: () => number
  private accounts: readonly V2Account[] = []
  private revoked: readonly { id: string; at: number }[] = []

  constructor(base: string, now: () => number = Date.now) {
    mkdirSync(base, { recursive: true })
    this.now = now
    this.file = path.join(base, V2_FILE)
    if (existsSync(this.file)) this.load()
  }

  /**
   * A TORN FILE STOPS THE PROCESS, and says which file.
   *
   * The alternative — starting empty — is worse than not starting: every
   * account would read as free, the first person to sign in would be told
   * their name is available, and the damage would be a new account written
   * over the evidence of the old one. So nothing is repaired and nothing is
   * reset; a human is told where to look.
   */
  private load(): void {
    const complain = (why: string): never => {
      throw new Error(
        `refusing to start: ${this.file} could not be read as an account file (${why}). ` +
          'Nothing has been changed — restore it from a backup, or move it aside to start with no accounts.'
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      complain(error instanceof Error ? error.message : 'it is not JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) complain('it is not an object')
    const held = parsed as Partial<Persisted>
    if (!Array.isArray(held.accounts)) complain('it has no list of accounts')
    for (const account of held.accounts as V2Account[]) {
      if (typeof account?.username !== 'string' || typeof account?.password?.hash !== 'string') {
        complain('an account in it has no username or no password')
      }
    }
    this.accounts = held.accounts as V2Account[]
    this.revoked = Array.isArray(held.revoked) ? (held.revoked as { id: string; at: number }[]) : []
  }

  /** Temp file then rename: a reader never sees half a write, whatever happens. */
  private save(): void {
    const body: Persisted = {
      version: 2,
      accounts: [...this.accounts],
      revoked: [...this.revoked]
    }
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(body), { mode: 0o600 })
      renameSync(temp, this.file)
    } catch (error) {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // The rename is what matters; a stranded temp file is not worth a throw.
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private replace(account: V2Account): V2Account {
    this.accounts = this.accounts.map((a) => (a.username === account.username ? account : a))
    this.save()
    return account
  }

  // ── reading ────────────────────────────────────────────────────────────

  has(username: string): boolean {
    return this.get(username) !== null
  }

  get(username: unknown): V2Account | null {
    if (typeof username !== 'string') return null
    const wanted = username.trim().toLowerCase()
    return this.accounts.find((a) => a.username === wanted) ?? null
  }

  /** What anyone may see: a name and a face, never a device. */
  publicProfile(username: string): { username: string; displayName: string; avatar?: string } | null {
    const account = this.get(username)
    if (!account) return null
    return {
      username: account.username,
      displayName: account.displayName,
      ...(account.avatar === null ? {} : { avatar: account.avatar })
    }
  }

  verifyPassword(username: string, password: string): boolean {
    return verifyPassword(this.get(username)?.password ?? null, password)
  }

  revokedDevices(): string[] {
    return this.revoked.map((r) => r.id)
  }

  /**
   * PHASE 4'S SEAM, and deliberately the only one.
   *
   * The sign-in ladder — passkey, authenticator, approve on a trusted device,
   * recovery code — is phase 4. Until then every account's answer is "nothing
   * more", and it is answered HERE so that the route does not grow a second
   * opinion about it later.
   */
  nextFactorFor(_account: V2Account): null {
    return null
  }

  // ── claiming and signing in ────────────────────────────────────────────

  create(input: {
    username: unknown
    password: unknown
    device: unknown
  }): Attached | Refused<CreateRefusal> {
    // STRICT ON THE WAY IN, forgiving on the way back: `@Drej` is refused with
    // the sentence the sheet shows rather than quietly becoming `@drej`, but
    // signing in later with any casing finds the account (see `get`).
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    if (!USERNAME.test(username) || username.startsWith(RESERVED_PREFIX)) {
      return { ok: false, reason: 'bad_username' }
    }
    if (this.has(username)) return { ok: false, reason: 'taken' }
    if (!passwordIsAcceptable(input.password)) return { ok: false, reason: 'weak_password' }
    const device = this.readDevice(input.device)
    if (device === null) return { ok: false, reason: 'bad_device' }
    // A device id another account already holds is not this account's device,
    // whatever it claims: one key, one place it is attached.
    if (this.ownerOfDevice(device.id) !== null) return { ok: false, reason: 'bad_device' }

    const account: V2Account = {
      username,
      password: hashPassword(input.password),
      displayName: '',
      avatar: null,
      claimedAt: this.now(),
      devices: [device],
      desktops: [],
      sessions: [],
      recovery: []
    }
    this.accounts = [...this.accounts, account]
    this.save()
    return { ok: true, account, device }
  }

  /**
   * The password path. Same refusal and same cost for a name nobody has taken
   * and a password that is wrong — see verifyPassword, which stretches against
   * a decoy rather than returning early.
   */
  signIn(input: { username: unknown; password: unknown; device: unknown }): Attached | Refused<'bad_credentials' | 'bad_device'> {
    const password = typeof input.password === 'string' ? input.password : ''
    const account = this.get(input.username)
    if (!verifyPassword(account?.password ?? null, password) || !account) {
      return { ok: false, reason: 'bad_credentials' }
    }
    return this.attachDevice(account.username, input.device)
  }

  /**
   * Attach a device, or recognise one already attached.
   *
   * A device id this account knows is REUSED rather than duplicated — a phone
   * that signs in twice is one phone — and its name and last-seen are brought
   * up to date, because "iPhone" being renamed should show on the profile.
   */
  attachDevice(username: string, input: unknown): Attached | Refused<'bad_credentials' | 'bad_device'> {
    const account = this.get(username)
    if (!account) return { ok: false, reason: 'bad_credentials' }
    const device = this.readDevice(input)
    if (device === null) return { ok: false, reason: 'bad_device' }
    const owner = this.ownerOfDevice(device.id)
    if (owner !== null && owner !== account.username) return { ok: false, reason: 'bad_device' }
    // A device that was revoked here cannot walk back in under its old id.
    if (this.revoked.some((r) => r.id === device.id)) return { ok: false, reason: 'bad_device' }

    const known = account.devices.find((d) => d.id === device.id)
    const attached: V2Device = known
      ? { ...known, kind: device.kind, name: device.name, jwk: device.jwk, lastSeenAt: this.now() }
      : device
    const next: V2Account = {
      ...account,
      devices: known
        ? account.devices.map((d) => (d.id === attached.id ? attached : d))
        : [...account.devices, attached]
    }
    this.replace(next)
    return { ok: true, account: next, device: attached }
  }

  private readDevice(input: unknown): V2Device | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
    const raw = input as Partial<DeviceInput>
    const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : ''
    if (!UUID.test(id)) return null
    if (raw.kind !== 'desktop' && raw.kind !== 'phone' && raw.kind !== 'browser') return null
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (name.length === 0 || name.length > DEVICE_NAME_MAX) return null
    const jwk = sanitiseJwk(raw.jwk)
    if (jwk === null) return null
    const at = this.now()
    return { id, kind: raw.kind, name, jwk, addedAt: at, lastSeenAt: at }
  }

  private ownerOfDevice(id: string): string | null {
    return this.accounts.find((a) => a.devices.some((d) => d.id === id))?.username ?? null
  }

  // ── sessions ───────────────────────────────────────────────────────────

  startSession(username: string, deviceId: string): V2Session | null {
    const account = this.get(username)
    if (!account || !account.devices.some((d) => d.id === deviceId)) return null
    const session: V2Session = { jti: randomUUID(), dev: deviceId, issuedAt: this.now() }
    // Bounded: the oldest goes so a long-lived account cannot grow a list
    // nobody reads into a file nobody can load.
    const sessions = [...account.sessions, session].slice(-SESSIONS_MAX)
    this.replace({ ...account, sessions })
    return session
  }

  isLiveSession(username: string, jti: string): boolean {
    return this.get(username)?.sessions.some((s) => s.jti === jti) ?? false
  }

  closeSession(username: string, jti: string): void {
    const account = this.get(username)
    if (!account) return
    this.replace({ ...account, sessions: account.sessions.filter((s) => s.jti !== jti) })
  }

  /**
   * The account and device a set of verified claims names, or null. The
   * signature was already checked; this is the half a signature cannot answer
   * — was this session ended, was this device taken away, does this account
   * still exist.
   */
  authenticate(claims: { sub: string; dev: string; jti: string }): { account: V2Account; device: V2Device } | null {
    const account = this.get(claims.sub)
    if (!account) return null
    const device = account.devices.find((d) => d.id === claims.dev)
    if (!device) return null
    if (!account.sessions.some((s) => s.jti === claims.jti)) return null
    return { account, device }
  }

  /** Last seen, for the Devices list. Written on a read, so it stays honest. */
  touch(username: string, deviceId: string): void {
    const account = this.get(username)
    if (!account) return
    const at = this.now()
    const devices = account.devices.map((d) => (d.id === deviceId ? { ...d, lastSeenAt: at } : d))
    this.replace({ ...account, devices })
  }

  // ── revoking ───────────────────────────────────────────────────────────

  /**
   * REVOKE. The device's sessions end with it, and its id joins the published
   * revoked list so a door verifying offline refuses it too. The CURRENT
   * device may be revoked — signing yourself out of the machine in your hand
   * is a thing people mean to do — but the LAST one may not: an account with
   * no device is an account nobody can prove.
   */
  revokeDevice(username: string, deviceId: string): { ok: true } | Refused<'last_device' | 'not_found'> {
    const account = this.get(username)
    if (!account) return { ok: false, reason: 'not_found' }
    if (!account.devices.some((d) => d.id === deviceId)) return { ok: false, reason: 'not_found' }
    if (account.devices.length <= 1) return { ok: false, reason: 'last_device' }
    this.replace({
      ...account,
      devices: account.devices.filter((d) => d.id !== deviceId),
      desktops: account.desktops.filter((d) => d.deviceId !== deviceId),
      sessions: account.sessions.filter((s) => s.dev !== deviceId)
    })
    this.revoked = [...this.revoked.filter((r) => r.id !== deviceId), { id: deviceId, at: this.now() }].slice(
      -REVOKED_MAX
    )
    this.save()
    return { ok: true }
  }

  // ── profile, desktops, password, recovery ──────────────────────────────

  setProfile(
    username: string,
    input: { displayName?: unknown; avatar?: unknown }
  ): { ok: true } | Refused<'not_found' | 'bad_profile'> {
    const account = this.get(username)
    if (!account) return { ok: false, reason: 'not_found' }
    let displayName = account.displayName
    if (input.displayName !== undefined) {
      if (typeof input.displayName !== 'string' || input.displayName.trim().length > DISPLAY_NAME_MAX) {
        return { ok: false, reason: 'bad_profile' }
      }
      displayName = input.displayName.trim()
    }
    let avatar = account.avatar
    if (input.avatar !== undefined) {
      if (input.avatar === null || input.avatar === '') avatar = null
      else if (typeof input.avatar !== 'string' || input.avatar.length > AVATAR_MAX || !AVATAR.test(input.avatar)) {
        return { ok: false, reason: 'bad_profile' }
      } else avatar = input.avatar
    }
    this.replace({ ...account, displayName, avatar })
    return { ok: true }
  }

  /**
   * A desktop tells the directory which workspaces exist on it, by name and
   * id. Only that desktop may — the route checks the token's device against
   * the path — and both lists are bounded, because this is a fact about a
   * machine and not a place to put a machine's contents.
   */
  putDesktop(
    username: string,
    deviceId: string,
    input: { name: unknown; workspaces: unknown }
  ): { ok: true } | Refused<'not_found' | 'bad_desktop'> {
    const account = this.get(username)
    if (!account) return { ok: false, reason: 'not_found' }
    const device = account.devices.find((d) => d.id === deviceId)
    if (!device) return { ok: false, reason: 'not_found' }
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length === 0 || name.length > DEVICE_NAME_MAX) return { ok: false, reason: 'bad_desktop' }
    if (!Array.isArray(input.workspaces) || input.workspaces.length > WORKSPACES_MAX) {
      return { ok: false, reason: 'bad_desktop' }
    }
    const workspaces: V2Workspace[] = []
    for (const raw of input.workspaces as unknown[]) {
      if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'bad_desktop' }
      const { id, name: label } = raw as { id?: unknown; name?: unknown }
      if (typeof id !== 'string' || id.length === 0 || id.length > WORKSPACE_NAME_MAX) {
        return { ok: false, reason: 'bad_desktop' }
      }
      if (typeof label !== 'string' || label.length === 0 || label.length > WORKSPACE_NAME_MAX) {
        return { ok: false, reason: 'bad_desktop' }
      }
      workspaces.push({ id, name: label })
    }
    const desktop: V2Desktop = { deviceId, name, workspaces, updatedAt: this.now() }
    const known = account.desktops.some((d) => d.deviceId === deviceId)
    this.replace({
      ...account,
      desktops: known ? account.desktops.map((d) => (d.deviceId === deviceId ? desktop : d)) : [...account.desktops, desktop]
    })
    return { ok: true }
  }

  changePassword(
    username: string,
    current: unknown,
    next: unknown
  ): { ok: true } | Refused<'bad_credentials' | 'weak_password'> {
    const account = this.get(username)
    if (!verifyPassword(account?.password ?? null, typeof current === 'string' ? current : '') || !account) {
      return { ok: false, reason: 'bad_credentials' }
    }
    if (!passwordIsAcceptable(next)) return { ok: false, reason: 'weak_password' }
    this.replace({ ...account, password: hashPassword(next) })
    return { ok: true }
  }

  /**
   * Eight codes, shown once, REPLACING any previous set — so an old sheet
   * found in a drawer opens nothing. Only their hashes are kept.
   */
  mintRecoveryCodes(username: string): string[] {
    const account = this.get(username)
    if (!account) return []
    const codes = Array.from({ length: RECOVERY_CODES }, () => mintRecoveryCode())
    this.replace({ ...account, recovery: codes.map((code) => hashRecoveryCode(code)) })
    return codes
  }

  /** Single use: the code that matched is consumed before this returns true. */
  useRecoveryCode(username: string, code: unknown): boolean {
    const account = this.get(username)
    if (!account || typeof code !== 'string') return false
    const at = account.recovery.findIndex((stored) => recoveryCodeMatches(stored, code))
    if (at < 0) return false
    this.replace({ ...account, recovery: account.recovery.filter((_, i) => i !== at) })
    return true
  }

  recoveryCodesLeft(username: string): number {
    return this.get(username)?.recovery.length ?? 0
  }
}
