import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { uuidFromDigest } from '../shared/device-id'
import { createPrivateKey } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import {
  bindMessage,
  buildRegistryAssertion,
  jwkThumbprint,
  type RegistryAssertion
} from './registry-assertion'

/**
 * THE ACCOUNT — one username, one file, every surface.
 *
 * Cookrew used to hold three names for one person: a handle from an env var
 * for serving, the OS username for calling, and nothing at all on the phone.
 * They could disagree, and when they did the failure was silent — two people
 * called `admin` shared a door's sandbox; a second laptop with the same handle
 * was refused with `not-yours` and no way in.
 *
 * So there is ONE file. `~/.cookrew/account.json` holds the username the
 * desktop minted and the key that proves it, 0600. Every other surface the
 * owner uses — the phone companion, a browser, a second laptop — is a DEVICE
 * bound to this account by a countersignature from a device already bound. The
 * registry keeps the tree; a door only ever needs its root, the handle.
 *
 * WHAT THIS FILE DOES NOT DO. It never prompts, never opens a window, and
 * never falls back to a name nobody chose: minting is an explicit act (the
 * setup sheet, or a dev-only env override that must MATCH), because a username
 * is permanent and first-mint-wins.
 */

export type DeviceKind = 'desktop' | 'phone' | 'browser' | 'passkey'

/** A device as the registry stores it: a key, what it is, and what to call it. */
export interface DeviceInput {
  id: string
  jwk: Record<string, unknown>
  kind: DeviceKind
  name: string
}

export interface DeviceRecord extends DeviceInput {
  boundBy?: string
  at?: string
}

/** `~/.cookrew/account.json`. The private key never leaves this process. */
export interface AccountFile {
  handle: string
  deviceId: string
  kind: 'desktop'
  name: string
  privateKeyJwk: Record<string, unknown>
  publicKeyJwk: Record<string, unknown>
  /** The registry origin this account was minted at. One account per app. */
  registry: string
  mintedAt: string
}

export type AccountFailure =
  | 'handle-taken'
  | 'handle-shape'
  | 'registry-unreachable'
  | 'refused'

/** A failure with a name the UI can branch on and a sentence it can show. */
export class AccountError extends Error {
  readonly reason: AccountFailure

  constructor(reason: AccountFailure, message: string) {
    super(message)
    this.name = 'AccountError'
    this.reason = reason
  }
}

/** A cookrew.dev handle. Same shape the registry and registry-token.ts hold. */
export const HANDLE_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** `acct-` is the door-side namespace for registry callers (served-callers.ts);
 *  a handle that starts with it could never sign in by key. Not mintable. */
export const RESERVED_HANDLE = /^acct-/
export const handleIsMintable = (handle: string): boolean =>
  HANDLE_SHAPE.test(handle) && !RESERVED_HANDLE.test(handle)

export type Fetch = typeof globalThis.fetch

export interface AccountOptions {
  /** Defaults to `~/.cookrew`. Tests pass a temp dir. */
  baseDir?: string
  /** Injected so a test needs no registry and no network. */
  fetch?: Fetch
  now?: () => number
}

const cookrewDir = (baseDir?: string): string => baseDir ?? path.join(homedir(), '.cookrew')

export function accountFile(baseDir?: string): string {
  return path.join(cookrewDir(baseDir), 'account.json')
}

/** The account this machine holds, or null when it has never minted one. */
export function loadAccount(baseDir?: string): AccountFile | null {
  const file = accountFile(baseDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountFile>
    if (
      typeof parsed.handle !== 'string' ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.registry !== 'string' ||
      parsed.privateKeyJwk === undefined ||
      parsed.publicKeyJwk === undefined
    ) {
      return null
    }
    return {
      handle: parsed.handle,
      deviceId: parsed.deviceId,
      kind: 'desktop',
      name: parsed.name ?? 'this computer',
      privateKeyJwk: parsed.privateKeyJwk,
      publicKeyJwk: parsed.publicKeyJwk,
      registry: parsed.registry,
      mintedAt: parsed.mintedAt ?? ''
    }
  } catch {
    // A corrupt account file is NOT repaired silently and NOT overwritten: the
    // handle it names may be the owner's only claim on their username, and a
    // fresh mint over it would take a second name while orphaning the first.
    // Null means "the app has no account" — the setup sheet then says so.
    return null
  }
}

/** Write the account privately. `mode` applies at creation only, so chmod too. */
export function writeAccount(account: AccountFile, baseDir?: string): AccountFile {
  const file = accountFile(baseDir)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Whole or not at all: a crash mid-write must not leave a half key on disk
  // that loads as "no account" and sends the owner back to a sheet whose
  // handle the registry already says is taken.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(account, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return account
}

/**
 * The OS username as a SUGGESTION — never an identity on its own (D3).
 *
 * `Drej.Smith` is not a handle, so it is folded into one here rather than
 * offered to the field and refused by the registry a second later.
 */
export function suggestHandle(raw?: string): string {
  const cleaned = String(raw ?? userInfo().username ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return HANDLE_SHAPE.test(cleaned) ? cleaned : ''
}

/** `@Drej ` and `drej` are the same typed intent. */
export function normaliseHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '')
}

export type HandleAvailability = 'free' | 'taken' | 'invalid' | 'unknown'

/**
 * Is this name free? `HEAD /v1/accounts/:handle` — 200 taken, 404 free.
 *
 * `unknown` is its own answer rather than an optimistic `free`: a field that
 * says "available" because the network is down invites a person to press a
 * button that then fails, and first-mint-wins makes that failure expensive.
 */
export async function checkHandle(
  handle: string,
  options: AccountOptions & { registry: string }
): Promise<HandleAvailability> {
  const clean = normaliseHandle(handle)
  if (!handleIsMintable(clean)) return 'invalid'
  const doFetch = options.fetch ?? globalThis.fetch
  try {
    const answer = await doFetch(new URL(`/v1/accounts/${clean}`, options.registry), {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    })
    if (answer.status === 200) return 'taken'
    if (answer.status === 404) return 'free'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Mint the account: a fresh ed25519 key, a name, and the registry's 201.
 *
 * The FILE IS WRITTEN ONLY ON 201. Writing first and registering after would
 * leave a machine believing it owns a handle the registry gave to somebody
 * else, and every later assert would fail with a message about signatures
 * rather than about the name.
 */
export async function mintAccount(
  input: { handle: string; registry: string; name?: string } & AccountOptions
): Promise<AccountFile> {
  const handle = normaliseHandle(input.handle)
  if (!handleIsMintable(handle)) {
    throw new AccountError(
      'handle-shape',
      'a username is 1–32 lowercase letters, digits or dashes, and cannot start or end with a dash'
    )
  }
  const doFetch = input.fetch ?? globalThis.fetch
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const privateKeyJwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>
  const name = input.name ?? 'this computer'
  // The device id is the registry's to assign; a proposal rides along so a
  // registry that echoes rather than mints still returns something usable.
  const proposed = uuidFromDigest(
    createHash('sha256').update(jwkThumbprint(publicKeyJwk)).digest()
  )

  let answer: Response
  try {
    answer = await doFetch(new URL('/v1/accounts', input.registry), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle,
        device: { id: proposed, jwk: publicKeyJwk, kind: 'desktop', name }
      }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    throw new AccountError(
      'registry-unreachable',
      'the registry did not answer — check the connection and try again; nothing was claimed'
    )
  }
  if (answer.status === 409) {
    throw new AccountError('handle-taken', `@${handle} is already taken — try another name`)
  }
  if (answer.status !== 201 && answer.status !== 200) {
    throw new AccountError('refused', `the registry refused the username (${answer.status})`)
  }
  const body = (await answer.json().catch(() => ({}))) as { handle?: string; deviceId?: string }
  const now = input.now ?? ((): number => Date.now())
  return writeAccount(
    {
      handle: body.handle ?? handle,
      deviceId: body.deviceId ?? proposed,
      kind: 'desktop',
      name,
      privateKeyJwk,
      publicKeyJwk,
      registry: input.registry,
      mintedAt: new Date(now()).toISOString()
    },
    input.baseDir
  )
}

export interface AccountSession {
  readonly handle: string
  readonly deviceId: string
  readonly registry: string
  /** The flat assert body the registry verifies: assertion ‖ scope ‖ device. */
  assertion(challenge: string, scope: string, aud?: string): RegistryAssertion & {
    scope: string
    device: string
    aud?: string
  }
  /** A short-lived token for one scope (and one door, for `call`). */
  token(scope: string, aud?: string): Promise<string>
  /** This account's signature over "device X, key Y, may sign for me". */
  vouchFor(device: DeviceInput): string
  bindDevice(device: DeviceInput): Promise<{ handle: string; deviceId: string }>
  listDevices(): Promise<readonly DeviceRecord[]>
  revokeDevice(id: string): Promise<boolean>
  linkCode(): Promise<{ code: string; exp: number }>
}

/** A token is reused while it has time on it; 15s of slack for the round trip. */
const TOKEN_SLACK_MS = 15_000

/**
 * The account, ready to speak to its registry.
 *
 * Separated from the file so every method is testable with a fetch stub and a
 * key in memory, and so the caller decides whether an absent account is an
 * error (serving) or a normal first run (the setup sheet).
 */
export function openAccount(account: AccountFile, options: AccountOptions = {}): AccountSession {
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? ((): number => Date.now())
  const origin = account.registry
  const held = new Map<string, string>()

  const assertion: AccountSession['assertion'] = (challenge, scope, aud) => ({
    ...buildRegistryAssertion({
      origin,
      // The credential id is the HANDLE, as the site and the old app both
      // send: it names the account. `device` names which of its keys signed.
      credentialId: account.handle,
      privateKeyJwk: account.privateKeyJwk,
      challenge
    }),
    scope,
    device: account.deviceId,
    ...(aud === undefined ? {} : { aud })
  })

  const post = async (at: string, body: unknown, bearer?: string): Promise<Response> =>
    doFetch(new URL(at, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` })
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000)
    })

  const token: AccountSession['token'] = async (scope, aud) => {
    const key = `${scope}|${aud ?? ''}`
    const cached = held.get(key)
    if (cached !== undefined && expiryOf(cached) > now() + TOKEN_SLACK_MS) return cached

    const asked = await post('/v1/identity/challenge', {})
    const offered = (await asked.json().catch(() => ({}))) as { challenge?: string }
    if (!asked.ok || typeof offered.challenge !== 'string') {
      throw new AccountError('registry-unreachable', 'the registry issued no challenge')
    }
    const minted = await post('/v1/identity/assert', assertion(offered.challenge, scope, aud))
    const out = (await minted.json().catch(() => ({}))) as { token?: string }
    if (!minted.ok || typeof out.token !== 'string') {
      throw new AccountError(
        'refused',
        `the registry refused this device's sign-in (${minted.status}) — it may have been revoked`
      )
    }
    held.set(key, out.token)
    return out.token
  }

  const vouchFor: AccountSession['vouchFor'] = (device) =>
    sign(
      null,
      Buffer.from(bindMessage(account.handle, device.id, jwkThumbprint(device.jwk)), 'utf8'),
      createPrivateKey({ key: account.privateKeyJwk as never, format: 'jwk' })
    ).toString('base64url')

  return {
    handle: account.handle,
    deviceId: account.deviceId,
    registry: origin,
    assertion,
    token,
    vouchFor,

    async bindDevice(device) {
      const bearer = await token('account')
      const answer = await post(
        `/v1/accounts/@${account.handle}/devices`,
        { device, vouch: vouchFor(device) },
        bearer
      )
      if (!answer.ok) {
        throw new AccountError(
          'refused',
          `the registry did not bind this device (${answer.status})`
        )
      }
      const body = (await answer.json().catch(() => ({}))) as { deviceId?: string }
      return { handle: account.handle, deviceId: body.deviceId ?? device.id }
    },

    async listDevices() {
      const bearer = await token('account')
      const answer = await doFetch(new URL(`/v1/accounts/@${account.handle}/devices`, origin), {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000)
      })
      if (!answer.ok) return []
      const body = (await answer.json().catch(() => ({}))) as { devices?: DeviceRecord[] }
      return Array.isArray(body.devices) ? body.devices : []
    },

    async revokeDevice(id) {
      const bearer = await token('account')
      const answer = await doFetch(
        new URL(`/v1/accounts/@${account.handle}/devices/${encodeURIComponent(id)}`, origin),
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${bearer}` },
          signal: AbortSignal.timeout(10_000)
        }
      )
      return answer.ok
    },

    async linkCode() {
      const bearer = await token('account')
      const answer = await post(`/v1/accounts/@${account.handle}/link-codes`, {}, bearer)
      const body = (await answer.json().catch(() => ({}))) as { code?: string; exp?: number }
      if (!answer.ok || typeof body.code !== 'string') {
        throw new AccountError('refused', 'the registry would not issue a link code')
      }
      return { code: body.code, exp: body.exp ?? 0 }
    }
  }
}

/** The `exp` a token carries, or 0 when it is not one we can read. */
function expiryOf(token: string): number {
  try {
    const [body] = token.split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp : 0
  } catch {
    return 0
  }
}

/** The account this machine holds, opened, or null on a first run. */
export function currentAccount(options: AccountOptions = {}): AccountSession | null {
  const stored = loadAccount(options.baseDir)
  return stored === null ? null : openAccount(stored, options)
}

export type ServingHandle =
  | { ok: true; handle: string }
  | { ok: false; reason: string }

/**
 * WHICH HANDLE THIS APP SERVES AND CALLS AS.
 *
 * `COOKREW_HANDLE` used to BE the identity: set it and the app served under
 * that name; unset it and the relay was simply off. It is now a development
 * override and nothing more, and an override that DISAGREES with the minted
 * account is refused out loud rather than adopted.
 *
 * Silently preferring either one would be a real loss: preferring the env
 * would serve a team under a name whose key this machine does not hold (every
 * caller's token then fails to verify at a door that says it is `@other`),
 * and preferring the account would leave a developer staring at an env var the
 * app decided to ignore. Refusing names the conflict where it can be fixed.
 */
export function resolveServingHandle(
  account: Pick<AccountFile, 'handle'> | null,
  envHandle?: string
): ServingHandle {
  const override = normaliseHandle(envHandle ?? '')
  if (account === null) {
    return {
      ok: false,
      reason:
        override.length > 0
          ? `COOKREW_HANDLE names @${override}, but this app has not minted a username yet — pick one in Cookrew first`
          : 'this app has not minted a username yet — pick one in Cookrew before serving'
    }
  }
  if (override.length > 0 && override !== account.handle) {
    return {
      ok: false,
      reason: `COOKREW_HANDLE says @${override} but this app is @${account.handle} — unset it or make it match`
    }
  }
  return { ok: true, handle: account.handle }
}
