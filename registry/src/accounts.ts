import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { publicJwk, type Jwk } from './jwk'

/**
 * ACCOUNTS — one username, many devices.
 *
 * The old model was one key per handle: a handle belonged to whichever browser
 * or laptop enrolled it first, and a second machine was simply refused. This
 * store replaces that with the shape the identity design asks for — an account
 * is a NAME, a device is a KEY, and a device is trusted because a device you
 * already hold said so.
 *
 * Three properties are load-bearing and are why this is a file rather than a
 * map in `identity.ts`:
 *
 *   REVOCATION IS REAL. A device can be dropped from any other device, and its
 *   record stays with a `revokedAt` rather than vanishing — a deleted row would
 *   let the same id be re-bound and inherit the tokens still in flight.
 *
 *   THE LAST DEVICE CANNOT LEAVE. Revoking it would strand the account with no
 *   key that can sign for it, and nobody holds a secret that could bring it
 *   back. That refusal is the whole of the recovery story.
 *
 *   MIGRATION IS NON-DESTRUCTIVE. The legacy flat credential map is read once
 *   and each entry becomes a one-device account; the old file is left exactly
 *   as it was, so a rollback loses nothing.
 */

/** The existing handle rule, unchanged — a handle is a route name. */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** A device id is chosen by the device and must be a UUID. */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type DeviceKind = 'desktop' | 'phone' | 'browser' | 'passkey'

const KINDS: readonly DeviceKind[] = ['desktop', 'phone', 'browser', 'passkey']

export interface Device {
  id: string
  jwk: Jwk
  kind: DeviceKind
  name: string
  /** The device that vouched — or how it got here when no device could. */
  boundBy: string
  at: number
  revokedAt?: number
  /** Passkeys only: the authenticator's own credential id, base64url. */
  credentialId?: string
}

export interface Account {
  devices: Device[]
}

export type Accounts = Record<string, Account>

/** A device as it arrives on the wire, before anything has been checked. */
export interface DeviceInput {
  id?: unknown
  jwk?: unknown
  kind?: unknown
  name?: unknown
}

export type MintFailure = 'taken' | 'bad_handle' | 'bad_device'
export type BindFailure = 'no_account' | 'bad_device' | 'device_exists'
export type RevokeFailure = 'no_account' | 'no_device' | 'last_device'

const MAX_NAME = 64
/** A person does not hold more keys than this, and an attacker should not. */
const MAX_DEVICES = 64

/** Normalise a device from the wire, or refuse it. Never trusts what it is given. */
export function readDevice(input: unknown): Omit<Device, 'boundBy' | 'at'> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = input as DeviceInput
  const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : ''
  if (!DEVICE_ID.test(id)) return null
  const jwk = publicJwk(raw.jwk)
  if (jwk === null) return null
  const kind = KINDS.find((k) => k === raw.kind)
  if (kind === undefined) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : ''
  if (name === '') return null
  return { id, jwk, kind, name }
}

/** A device as it may be shown: no private material, ever. */
export function presentable(device: Device): Record<string, unknown> {
  return {
    id: device.id,
    jwk: publicJwk(device.jwk),
    kind: device.kind,
    name: device.name,
    boundBy: device.boundBy,
    at: device.at,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
    ...(device.credentialId === undefined ? {} : { credentialId: device.credentialId })
  }
}

export class AccountStore {
  private readonly file: string
  private readonly now: () => number
  private accounts: Accounts = {}

  constructor(base: string, now: () => number = Date.now) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, 'accounts.json')
    this.now = now
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Accounts
        this.accounts = sane(parsed)
      } catch {
        this.accounts = {}
      }
    }
  }

  /**
   * Fold the legacy flat credential map in. Additive: a handle that already has
   * an account is left alone, so running this twice — or after devices have
   * been bound — changes nothing.
   */
  migrate(legacy: readonly { credentialId: string; jwk: Jwk }[]): number {
    let added = 0
    for (const credential of legacy) {
      const handle = credential.credentialId.toLowerCase()
      if (!HANDLE.test(handle) || this.accounts[handle] !== undefined) continue
      const jwk = publicJwk(credential.jwk)
      if (jwk === null) continue
      this.accounts = {
        ...this.accounts,
        [handle]: {
          devices: [
            {
              id: randomUUID(),
              jwk,
              kind: 'browser',
              name: 'the key that enrolled this handle',
              boundBy: 'first',
              at: this.now()
            }
          ]
        }
      }
      added += 1
    }
    if (added > 0) this.persist()
    return added
  }

  /** Every handle with an account. */
  handles(): string[] {
    return Object.keys(this.accounts)
  }

  exists(handle: string): boolean {
    return this.accounts[handle.toLowerCase()] !== undefined
  }

  get(handle: string): Account | null {
    return this.accounts[handle.toLowerCase()] ?? null
  }

  /** Devices of an account, revoked ones included — the list a person manages. */
  devices(handle: string): readonly Device[] {
    return this.get(handle)?.devices ?? []
  }

  /** The devices that may still sign. */
  active(handle: string): readonly Device[] {
    return this.devices(handle).filter((d) => d.revokedAt === undefined)
  }

  device(handle: string, id: string): Device | null {
    return this.devices(handle).find((d) => d.id === id.toLowerCase()) ?? null
  }

  /** An unrevoked device, by id — the only kind that may act. */
  signer(handle: string, id: string): Device | null {
    const device = this.device(handle, id)
    return device !== null && device.revokedAt === undefined ? device : null
  }

  /** The passkey with this credential id, wherever it lives. */
  byCredentialId(credentialId: string): { handle: string; device: Device } | null {
    for (const [handle, account] of Object.entries(this.accounts)) {
      const device = account.devices.find((d) => d.credentialId === credentialId)
      if (device) return { handle, device }
    }
    return null
  }

  /**
   * Every revoked device id, for the key document a door caches. Short by
   * construction: an account has few devices and most are live.
   */
  revoked(): string[] {
    return Object.values(this.accounts)
      .flatMap((a) => a.devices)
      .filter((d) => d.revokedAt !== undefined)
      .map((d) => d.id)
  }

  isRevoked(deviceId: string): boolean {
    return Object.values(this.accounts).some((a) =>
      a.devices.some((d) => d.id === deviceId && d.revokedAt !== undefined)
    )
  }

  /**
   * Mint an account with its first device. TOFU, and first mint wins: a handle
   * already held is refused rather than merged, because "merged" would mean a
   * stranger's key joining someone else's account.
   */
  mint(
    handle: string,
    input: unknown
  ): { ok: true; handle: string; deviceId: string } | { ok: false; reason: MintFailure } {
    const clean = handle.toLowerCase()
    if (!HANDLE.test(clean)) return { ok: false, reason: 'bad_handle' }
    const device = readDevice(input)
    if (device === null) return { ok: false, reason: 'bad_device' }
    if (this.accounts[clean] !== undefined) return { ok: false, reason: 'taken' }
    this.accounts = {
      ...this.accounts,
      [clean]: { devices: [{ ...device, boundBy: 'first', at: this.now() }] }
    }
    this.persist()
    return { ok: true, handle: clean, deviceId: device.id }
  }

  /**
   * Bind a device that an existing one vouched for. `boundBy` is the voucher's
   * id — or `code` / `passkey` when the vouch came through a link code or a
   * platform authenticator instead.
   */
  bind(
    handle: string,
    input: unknown,
    boundBy: string,
    extra: { credentialId?: string } = {}
  ): { ok: true; deviceId: string } | { ok: false; reason: BindFailure } {
    const clean = handle.toLowerCase()
    const account = this.accounts[clean]
    if (account === undefined) return { ok: false, reason: 'no_account' }
    const device = readDevice(input)
    if (device === null) return { ok: false, reason: 'bad_device' }
    if (account.devices.length >= MAX_DEVICES) return { ok: false, reason: 'bad_device' }
    // An id already known cannot be re-bound, revoked or not: reusing one would
    // resurrect a revoked device's name and every token still carrying it.
    if (account.devices.some((d) => d.id === device.id)) return { ok: false, reason: 'device_exists' }
    if (
      extra.credentialId !== undefined &&
      this.byCredentialId(extra.credentialId) !== null
    ) {
      return { ok: false, reason: 'device_exists' }
    }
    this.accounts = {
      ...this.accounts,
      [clean]: {
        devices: [
          ...account.devices,
          {
            ...device,
            boundBy,
            at: this.now(),
            ...(extra.credentialId === undefined ? {} : { credentialId: extra.credentialId })
          }
        ]
      }
    }
    this.persist()
    return { ok: true, deviceId: device.id }
  }

  /** Revoke a device. The last unrevoked one cannot go — see the file header. */
  revoke(handle: string, id: string): { ok: true } | { ok: false; reason: RevokeFailure } {
    const clean = handle.toLowerCase()
    const account = this.accounts[clean]
    if (account === undefined) return { ok: false, reason: 'no_account' }
    const target = account.devices.find((d) => d.id === id.toLowerCase())
    if (target === undefined) return { ok: false, reason: 'no_device' }
    if (target.revokedAt !== undefined) return { ok: true }
    if (account.devices.filter((d) => d.revokedAt === undefined).length <= 1) {
      return { ok: false, reason: 'last_device' }
    }
    const at = this.now()
    this.accounts = {
      ...this.accounts,
      [clean]: {
        devices: account.devices.map((d) => (d.id === target.id ? { ...d, revokedAt: at } : d))
      }
    }
    this.persist()
    return { ok: true }
  }

  /** Forget every account. DEV ONLY — the twin of the credential map's own. */
  forgetAll(): void {
    this.accounts = {}
    this.persist()
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.accounts, null, 2))
  }
}

/** Read a persisted file defensively: a hand-edited entry must not crash boot. */
function sane(parsed: unknown): Accounts {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Accounts = {}
  for (const [handle, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!HANDLE.test(handle)) continue
    const devices = (value as Account | undefined)?.devices
    if (!Array.isArray(devices)) continue
    const kept = devices.flatMap((device: unknown) => {
      const base = readDevice(device)
      if (base === null) return []
      const raw = device as Device
      return [
        {
          ...base,
          boundBy: typeof raw.boundBy === 'string' ? raw.boundBy : 'first',
          at: typeof raw.at === 'number' ? raw.at : 0,
          ...(typeof raw.revokedAt === 'number' ? { revokedAt: raw.revokedAt } : {}),
          ...(typeof raw.credentialId === 'string' ? { credentialId: raw.credentialId } : {})
        }
      ]
    })
    if (kept.length > 0) out[handle] = { devices: kept }
  }
  return out
}

/* ── link codes ─────────────────────────────────────────────────────────── */

/**
 * The six characters a person reads off one screen and types into another.
 *
 * No I, O, 0 or 1: every pair of those is the mistake somebody makes at arm's
 * length from a phone, and a code that fails because it was read correctly and
 * typed correctly is the worst kind of refusal.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
/** In memory and capped: a code is worthless in two minutes and must not accrue. */
const MAX_CODES = 512

export interface LinkCode {
  code: string
  exp: number
}

export type CodeFailure = 'unknown' | 'expired' | 'wrong_handle'

export class LinkCodes {
  private readonly codes = new Map<string, { handle: string; by: string; exp: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Issue a code for one account, vouched by one of its devices. */
  issue(handle: string, by: string): LinkCode {
    this.sweep()
    if (this.codes.size >= MAX_CODES) {
      // Drop the oldest rather than refuse: a full table is a busy registry,
      // and a person waiting to link a browser should not pay for it.
      const oldest = [...this.codes.entries()].sort((a, b) => a[1].exp - b[1].exp)[0]
      if (oldest) this.codes.delete(oldest[0])
    }
    let code = ''
    do {
      code = draw()
    } while (this.codes.has(code))
    const exp = this.now() + this.ttlMs
    this.codes.set(code, { handle: handle.toLowerCase(), by, exp })
    return { code, exp }
  }

  /**
   * Spend a code. Single use, and consumed even when the handle does not match
   * — a code that survived a wrong guess would be a code an attacker can grind.
   */
  spend(
    code: string,
    handle: string
  ): { ok: true; by: string } | { ok: false; reason: CodeFailure } {
    // Looked up BEFORE the sweep, so a code that has just run out is told it
    // expired rather than that it never existed — the difference between "ask
    // for another" and "you typed it wrong".
    const key = String(code ?? '').trim().toUpperCase()
    const entry = this.codes.get(key)
    this.codes.delete(key)
    this.sweep()
    if (entry === undefined) return { ok: false, reason: 'unknown' }
    if (entry.exp < this.now()) return { ok: false, reason: 'expired' }
    if (entry.handle !== handle.toLowerCase()) return { ok: false, reason: 'wrong_handle' }
    return { ok: true, by: entry.by }
  }

  private sweep(): void {
    for (const [code, entry] of this.codes) {
      if (entry.exp < this.now()) this.codes.delete(code)
    }
  }
}

function draw(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}
