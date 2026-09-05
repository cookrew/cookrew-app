import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { passwordGate } from './v2-hash-gate'
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
import type { V2Reach } from './v2-reach'

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
/**
 * Revoked ids kept PER ACCOUNT.
 *
 * It was one 500-long ring across the whole registry, which meant a busy
 * account's revocations quietly evicted a quiet account's — so a phone
 * somebody revoked in March could come back because a stranger cycled five
 * hundred devices in April. A cap per account cannot be spent by anyone but
 * its owner.
 */
const REVOKED_MAX = 200
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
  /**
   * WHERE THIS MACHINE CAN BE FOUND, as it signed it. Absent until the
   * desktop has published one, and readable only by the account's own devices
   * — an address is a directory fact about a machine, not a public one.
   */
  reach: V2Reach | null
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
  /**
   * Ids this account has taken back: device ids AND session ids.
   *
   * Both, and published together, because a door verifies a token OFFLINE
   * against /v2/keys — it can see neither our session list nor our device
   * list. A device id here means "this device is gone"; a session id means
   * "this one sitting was ended" (a password change ends the others without
   * detaching the phone they were on, which taking the device away would).
   */
  revoked?: readonly { id: string; at: number }[]
}

interface Persisted {
  version: 2
  accounts: V2Account[]
}

export type CreateRefusal = 'taken' | 'bad_username' | 'weak_password' | 'bad_device'
export type Refused<R extends string> = { ok: false; reason: R }
export type Attached = { ok: true; account: V2Account; device: V2Device }

export class V2Accounts {
  private readonly file: string
  private readonly now: () => number
  private accounts: readonly V2Account[] = []
  /** Names being claimed right now — see `create`, which awaits a hash midway. */
  private readonly claiming = new Set<string>()

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
  }

  /** Temp file then rename: a reader never sees half a write, whatever happens. */
  private save(): void {
    const body: Persisted = { version: 2, accounts: [...this.accounts] }
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

  verifyPassword(username: string, password: string): Promise<boolean> {
    return passwordGate.run(() => verifyPassword(this.get(username)?.password ?? null, password))
  }

  /**
   * Every id this registry has taken back, flat. Device ids and session ids
   * are both opaque to a door: it refuses a token naming either.
   */
  revokedIds(): string[] {
    return this.accounts.flatMap((a) => (a.revoked ?? []).map((r) => r.id))
  }

  /** The ids one account has taken back — for tests and for a person's own page. */
  revokedFor(username: string): string[] {
    return (this.get(username)?.revoked ?? []).map((r) => r.id)
  }

  private withRevoked(account: V2Account, ids: readonly string[]): V2Account {
    const at = this.now()
    const held = (account.revoked ?? []).filter((r) => !ids.includes(r.id))
    return { ...account, revoked: [...held, ...ids.map((id) => ({ id, at }))].slice(-REVOKED_MAX) }
  }

  /**
   * PHASE 4 FILLED THIS SEAM, and moved it.
   *
   * The ladder — passkey, authenticator, approve on a trusted device,
   * recovery code — needs to know what an account HAS, and what it has lives
   * in `v2-factor-store.ts` (a TOTP seed is a secret; it does not belong in
   * the file rendered on every profile). So the decision is made in
   * `factorsFor` there, and this store keeps the two things only it can
   * answer: the devices, and the sittings below.
   */

  /**
   * END EVERY SITTING BUT ONE — what "not me" does.
   *
   * The same machinery a password change uses: the other session ids join the
   * published revoked list, so a door verifying OFFLINE refuses them without
   * asking us, and the devices stay attached (taking somebody's phone off the
   * account is not what they said). The caller's own sitting survives.
   */
  endOtherSessions(username: string, keepJti: string): number {
    const account = this.get(username)
    if (!account) return 0
    const ended = this.otherSessions(account, keepJti)
    if (ended.length === 0) return 0
    this.replace(this.withRevoked({ ...account, sessions: this.keptSessions(account, keepJti) }, ended))
    return ended.length
  }

  // ── claiming and signing in ────────────────────────────────────────────

  async create(input: {
    username: unknown
    password: unknown
    device: unknown
  }): Promise<Attached | Refused<CreateRefusal>> {
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

    /**
     * THE NAME IS HELD ACROSS THE HASH. Stretching a password takes long
     * enough that two requests could both pass the "is it taken" check above
     * and both write; the name is reserved for the duration and checked once
     * more after, because a username minted twice is the one thing this store
     * exists to make impossible.
     */
    if (this.claiming.has(username)) return { ok: false, reason: 'taken' }
    this.claiming.add(username)
    let hashed: Hashed
    try {
      hashed = await passwordGate.run(() => hashPassword(input.password as string))
    } finally {
      this.claiming.delete(username)
    }
    if (this.has(username)) return { ok: false, reason: 'taken' }

    const account: V2Account = {
      username,
      password: hashed,
      displayName: '',
      avatar: null,
      claimedAt: this.now(),
      devices: [device],
      desktops: [],
      sessions: [],
      recovery: [],
      revoked: []
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
  async signIn(input: {
    username: unknown
    password: unknown
    device: unknown
  }): Promise<Attached | Refused<'bad_credentials' | 'bad_device'>> {
    const password = typeof input.password === 'string' ? input.password : ''
    const account = this.get(input.username)
    const right = await passwordGate.run(() => verifyPassword(account?.password ?? null, password))
    if (!right || !account) {
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
    if ((account.revoked ?? []).some((r) => r.id === device.id)) return { ok: false, reason: 'bad_device' }

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

  /**
   * WOULD THIS DEVICE ATTACH? Asked before a rung is climbed.
   *
   * The ladder holds a device payload for ten minutes without acting on it,
   * and only attaches when a factor passes. Without this, a payload that can
   * never attach — an unusable key, an id another account holds, an id this
   * account revoked — would be discovered AFTER a recovery code had been
   * spent on it. The same rules `attachDevice` applies, asked early and
   * changing nothing.
   */
  mayAttach(username: string, input: unknown): boolean {
    const account = this.get(username)
    if (!account) return false
    const device = this.readDevice(input)
    if (device === null) return false
    const owner = this.ownerOfDevice(device.id)
    if (owner !== null && owner !== account.username) return false
    return !(account.revoked ?? []).some((r) => r.id === device.id)
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
    // The device AND every sitting it opened: a door checking offline sees
    // both in the published list, so neither outlives the revocation.
    const ended = account.sessions.filter((s) => s.dev === deviceId).map((s) => s.jti)
    this.replace(
      this.withRevoked(
        {
          ...account,
          devices: account.devices.filter((d) => d.id !== deviceId),
          desktops: account.desktops.filter((d) => d.deviceId !== deviceId),
          sessions: account.sessions.filter((s) => s.dev !== deviceId)
        },
        [deviceId, ...ended]
      )
    )
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
    input: { name: unknown; workspaces: unknown; reach?: V2Reach | null }
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
    // A PUT with no reach keeps the one already stored: a desktop that is
    // only renaming a workspace has not forgotten where it lives, and making
    // it re-sign a card to say so would mean the address disappears whenever
    // the two writes are not made together.
    const held = account.desktops.find((d) => d.deviceId === deviceId) ?? null
    const reach = input.reach === undefined ? (held?.reach ?? null) : input.reach
    const desktop: V2Desktop = { deviceId, name, workspaces, reach, updatedAt: this.now() }
    const known = held !== null
    this.replace({
      ...account,
      desktops: known ? account.desktops.map((d) => (d.deviceId === deviceId ? desktop : d)) : [...account.desktops, desktop]
    })
    return { ok: true }
  }

  /**
   * CHANGING A PASSWORD ENDS EVERY OTHER SITTING.
   *
   * Somebody changes their password because they think someone else has it.
   * Leaving the other sessions open would mean the change did nothing to the
   * only thing they were worried about. The caller's own session survives —
   * being signed out of the browser you just used reads as a failure — and
   * the ended session ids join the published revoked list, so a door refuses
   * them without asking us.
   */
  async changePassword(
    username: string,
    current: unknown,
    next: unknown,
    keepJti?: string
  ): Promise<{ ok: true } | Refused<'bad_credentials' | 'weak_password'>> {
    const account = this.get(username)
    const right = await passwordGate.run(() =>
      verifyPassword(account?.password ?? null, typeof current === 'string' ? current : '')
    )
    if (!right || !account) return { ok: false, reason: 'bad_credentials' }
    if (!passwordIsAcceptable(next)) return { ok: false, reason: 'weak_password' }
    const hashed = await passwordGate.run(() => hashPassword(next))
    // Re-read: stretching took long enough that a device may have signed in
    // meanwhile, and that sitting must be ended by this change too.
    const fresh = this.get(username) ?? account
    this.replace(
      this.withRevoked(
        { ...fresh, password: hashed, sessions: this.keptSessions(fresh, keepJti) },
        this.otherSessions(fresh, keepJti)
      )
    )
    return { ok: true }
  }

  private otherSessions(account: V2Account, keepJti?: string): string[] {
    return account.sessions.filter((s) => s.jti !== keepJti).map((s) => s.jti)
  }
  private keptSessions(account: V2Account, keepJti?: string): V2Session[] {
    return account.sessions.filter((s) => s.jti === keepJti)
  }

  /**
   * Eight codes, shown once, REPLACING any previous set — so an old sheet
   * found in a drawer opens nothing. Only their hashes are kept.
   */
  mintRecoveryCodes(username: string, keepJti?: string): string[] {
    const account = this.get(username)
    if (!account) return []
    const codes = Array.from({ length: RECOVERY_CODES }, () => mintRecoveryCode())
    // Same reasoning as a password change: a new sheet of codes is what a
    // person does when they think someone else is in, so the other sittings
    // end with it and their ids are published as revoked.
    this.replace(
      this.withRevoked(
        {
          ...account,
          recovery: codes.map((code) => hashRecoveryCode(code)),
          sessions: this.keptSessions(account, keepJti)
        },
        this.otherSessions(account, keepJti)
      )
    )
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
