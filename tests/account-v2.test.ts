// THE ONE ACCOUNT FILE, and the rule that it is written only when the registry
// says the name is ours.
//
// Every test here runs against a temp directory. The real ~/.cookrew is never
// touched and no socket is opened — `fetch` is injected — so the suite cannot
// claim a username on the live registry by accident.
//
// NO SECRET IS PRINTED. Passwords in fixtures are obviously-fake strings and
// nothing asserts on a token's value.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Accounts,
  DEFAULT_LOCK_AFTER_MS,
  accountFilePath,
  deviceIdFor,
  loadAccount,
  matchesUnlock,
  mintDeviceKey,
  unlockVerifierFor,
  writeAccount,
  type AccountFile,
} from '../src/main/account-v2'
import { isValidUsername, normaliseUsername, passwordStrength } from '../src/shared/account-v2'

const PASSWORD = 'correct-horse-battery'
const ORIGIN = 'https://registry.test'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-account-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fetch that answers a scripted list and records what it was asked. */
function scriptedFetch(replies: readonly { status: number; body?: unknown }[]): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  calls: RequestInit[]
  urls: string[]
} {
  const calls: RequestInit[] = []
  const urls: string[] = []
  let index = 0
  return {
    urls,
    calls,
    fetch: (url, init) => {
      urls.push(url)
      calls.push(init ?? {})
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      // 204 carries no body at all — `new Response('', {status: 204})` throws,
      // and a throw here would read as "offline" and hide the real assertion.
      const body =
        reply.status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body)
      return Promise.resolve(
        new Response(body, {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    },
  }
}

const accounts = (
  base: string,
  replies: readonly { status: number; body?: unknown }[] = [{ status: 500 }],
): { it: Accounts; urls: string[]; calls: RequestInit[] } => {
  const script = scriptedFetch(replies)
  return {
    it: new Accounts({ base, origin: ORIGIN, fetch: script.fetch, deviceName: 'Test Mac' }),
    urls: script.urls,
    calls: script.calls,
  }
}

const CLAIMED = { username: 'drej', deviceId: 'ignored', session: { token: 'tok', exp: 2e12 } }

describe('the name and password rules, shared by the field and the claim', () => {
  it('takes a name as typed and gives it back as claimed', () => {
    expect(normaliseUsername('  @drej ')).toBe('drej')
    expect(isValidUsername('@drej-2')).toBe(true)
    expect(isValidUsername('a'.repeat(32))).toBe(true)
    expect(isValidUsername('a'.repeat(33))).toBe(false)
  })

  it('REFUSES rather than folds a name with capitals or spaces', () => {
    // Silently lowercasing "Drej Smith" would claim a name nobody typed.
    expect(isValidUsername('Drej')).toBe(false)
    expect(isValidUsername('drej smith')).toBe(false)
    expect(isValidUsername('')).toBe(false)
  })

  it('meters the password on length first, then on classes', () => {
    expect(passwordStrength('short')).toBe('weak')
    expect(passwordStrength('abcdefghijk')).toBe('weak') // eleven
    expect(passwordStrength('abcdefghijkl')).toBe('ok') // twelve, one class
    expect(passwordStrength('abcdefghijklmnop')).toBe('strong') // sixteen
    expect(passwordStrength('abcDEF123456')).toBe('strong') // three classes at the floor
  })
})

describe('a reserved prefix is refused HERE, and named', () => {
  it('answers "reserved" without opening a socket', async () => {
    // The registry answers `bad_username`, which the sheet would render as the
    // lowercase-and-dashes sentence about a name that IS lowercase.
    const script = accounts(scratch(), [{ status: 404 }])
    expect(await script.it.checkUsername('acct-x')).toBe('reserved')
    expect(script.urls).toHaveLength(0)
  })

  it('carries the real reason as the message when a claim is attempted', async () => {
    const base = scratch()
    const script = accounts(base, [{ status: 201, body: CLAIMED }])
    const result = await script.it.claim({ username: 'acct-x', password: PASSWORD })
    expect(result).toMatchObject({ ok: false, reason: 'bad_username' })
    expect(result.ok === false && result.message).toBe(
      'acct- is reserved for the doors — pick another name.',
    )
    expect(script.urls).toHaveLength(0)
    expect(loadAccount(base)).toBeNull()
  })

  it('still refuses a malformed name as a shape problem', async () => {
    expect(await accounts(scratch()).it.checkUsername('Drej Smith')).toBe('invalid')
  })
})

describe('the device id is a pure function of the key', () => {
  const key = mintDeviceKey()

  it('is UUID-shaped and stable for the same key', () => {
    const first = deviceIdFor(key.publicKeyJwk)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(deviceIdFor({ ...key.publicKeyJwk })).toBe(first)
  })

  it('ignores members that are not part of the thumbprint', () => {
    // RFC 7638: crv, kty, x and nothing else. A `use` or `alg` the registry
    // added must not rename the device.
    expect(deviceIdFor({ ...key.publicKeyJwk, use: 'sig', alg: 'EdDSA' })).toBe(
      deviceIdFor(key.publicKeyJwk),
    )
  })

  it('differs for a different key', () => {
    expect(deviceIdFor(mintDeviceKey().publicKeyJwk)).not.toBe(deviceIdFor(key.publicKeyJwk))
  })
})

describe('the file: 0600, atomic, and forgiving of a corrupt one', () => {
  const sample = (base: string): AccountFile => {
    const key = mintDeviceKey()
    return {
      username: 'drej',
      deviceId: deviceIdFor(key.publicKeyJwk),
      kind: 'desktop',
      name: 'Test Mac',
      ...key,
      registry: ORIGIN,
      session: { token: 'tok', exp: 2e12 },
      unlock: unlockVerifierFor(PASSWORD),
      lockAfterMs: DEFAULT_LOCK_AFTER_MS,
      claimedAt: 1,
      workspacesReachable: true,
      recoveryCodesSavedAt: null,
      ...(base ? {} : {}),
    }
  }

  it('writes owner-read/write only, and leaves no temp behind', () => {
    const base = scratch()
    writeAccount(sample(base), base)
    const file = accountFilePath(base)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(() => statSync(`${file}.tmp`)).toThrow()
  })

  it('round-trips through load', () => {
    const base = scratch()
    const account = sample(base)
    writeAccount(account, base)
    expect(loadAccount(base)?.username).toBe('drej')
    expect(loadAccount(base)?.deviceId).toBe(account.deviceId)
  })

  it('reads a corrupt file as NO ACCOUNT rather than throwing', () => {
    // P4: the app is fully usable without an account, so the worst a broken
    // file may do is show the claim sheet again — never refuse to boot.
    const base = scratch()
    writeAccount(sample(base), base)
    writeFileSync(accountFilePath(base), '{ not json', 'utf8')
    expect(loadAccount(base)).toBeNull()
    expect(loadAccount(scratch())).toBeNull()
  })
})

describe('the unlock verifier', () => {
  it('says yes to the password and no to anything else', () => {
    const verifier = unlockVerifierFor(PASSWORD)
    expect(matchesUnlock(verifier, PASSWORD)).toBe(true)
    expect(matchesUnlock(verifier, `${PASSWORD}x`)).toBe(false)
    expect(matchesUnlock(verifier, '')).toBe(false)
  })

  it('salts per install, so two Macs with one password store different bytes', () => {
    expect(unlockVerifierFor(PASSWORD).hash).not.toBe(unlockVerifierFor(PASSWORD).hash)
  })

  it('never stores the password itself', () => {
    const verifier = unlockVerifierFor(PASSWORD)
    expect(JSON.stringify(verifier)).not.toContain(PASSWORD)
  })
})

describe('checkUsername is never optimistic', () => {
  it('reads 200 as taken and 404 as free', async () => {
    const base = scratch()
    expect(await accounts(base, [{ status: 200 }]).it.checkUsername('drej')).toBe('taken')
    expect(await accounts(base, [{ status: 404 }]).it.checkUsername('drej')).toBe('free')
  })

  it('judges the shape locally before asking', async () => {
    const script = accounts(scratch(), [{ status: 404 }])
    expect(await script.it.checkUsername('Drej Smith')).toBe('invalid')
    expect(script.urls).toHaveLength(0)
  })

  it('answers UNKNOWN when the registry is silent or strange', async () => {
    // Guessing "free" here is what produces an enabled primary and a refused
    // submission — the exact outcome the sheet exists to prevent.
    expect(await accounts(scratch(), [{ status: 503 }]).it.checkUsername('drej')).toBe('unknown')
    const offline = new Accounts({
      base: scratch(),
      origin: ORIGIN,
      fetch: () => Promise.reject(new Error('no network')),
    })
    expect(await offline.checkUsername('drej')).toBe('unknown')
  })
})

describe('claim writes the file ONLY on 201', () => {
  it('files the account, derives the device id from the key, and defaults the lock', async () => {
    const base = scratch()
    const script = accounts(base, [{ status: 201, body: CLAIMED }])
    const result = await script.it.claim({ username: '@drej', password: PASSWORD })
    expect(result.ok).toBe(true)
    const stored = loadAccount(base)
    expect(stored?.username).toBe('drej')
    expect(stored?.lockAfterMs).toBe(DEFAULT_LOCK_AFTER_MS)
    expect(stored?.registry).toBe(ORIGIN)
    // The device the registry was SENT carries the id derived from its key.
    const sent = JSON.parse(String(script.calls[0].body)) as {
      device: { id: string; kind: string; jwk: Record<string, unknown> }
    }
    expect(sent.device.kind).toBe('desktop')
    expect(sent.device.id).toBe(deviceIdFor(sent.device.jwk))
  })

  it('leaves the desktop local when the name is taken', async () => {
    const base = scratch()
    const script = accounts(base, [
      { status: 409, body: { error: 'taken', message: '@drej is someone else’s. Try another.' } },
    ])
    const result = await script.it.claim({ username: 'drej', password: PASSWORD })
    expect(result).toMatchObject({ ok: false, reason: 'taken' })
    // The registry's own sentence is carried, not re-worded.
    expect(result.ok === false && result.message).toContain('someone else')
    expect(loadAccount(base)).toBeNull()
  })

  it('refuses a short password without asking the registry', async () => {
    const base = scratch()
    const script = accounts(base, [{ status: 201, body: CLAIMED }])
    expect(await script.it.claim({ username: 'drej', password: 'short' })).toMatchObject({
      ok: false,
      reason: 'weak_password',
    })
    expect(script.urls).toHaveLength(0)
  })

  it('carries 400 bad_username, 400 bad_device and 429 as themselves', async () => {
    for (const [reply, reason] of [
      [{ status: 400, body: { error: 'bad_username' } }, 'bad_username'],
      [{ status: 400, body: { error: 'bad_device' } }, 'bad_device'],
      [{ status: 429 }, 'rate_limited'],
    ] as const) {
      const base = scratch()
      const result = await accounts(base, [reply]).it.claim({
        username: 'drej',
        password: PASSWORD,
      })
      expect(result).toMatchObject({ ok: false, reason })
      expect(loadAccount(base)).toBeNull()
    }
  })

  it('leaves nothing behind when the registry cannot be reached at all', async () => {
    const base = scratch()
    const offline = new Accounts({
      base,
      origin: ORIGIN,
      fetch: () => Promise.reject(new Error('no network')),
    })
    expect(await offline.claim({ username: 'drej', password: PASSWORD })).toMatchObject({
      ok: false,
      reason: 'offline',
    })
    expect(loadAccount(base)).toBeNull()
  })
})

describe('the session, and what happens when it dies', () => {
  const claimed = async (
    base: string,
    exp: number,
    replies: readonly { status: number; body?: unknown }[],
  ): Promise<Accounts> => {
    const script = scriptedFetch([
      { status: 201, body: { ...CLAIMED, session: { token: 'tok', exp } } },
      ...replies,
    ])
    const it = new Accounts({ base, origin: ORIGIN, fetch: script.fetch })
    await it.claim({ username: 'drej', password: PASSWORD })
    return it
  }

  it('refuses an authed call with a dead session BEFORE opening a socket', async () => {
    const base = scratch()
    const it = await claimed(base, Date.now() - 1000, [{ status: 200, body: {} }])
    expect(await it.profile()).toMatchObject({ ok: false, reason: 'session-expired' })
  })

  it('trades the password for a new session and files it', async () => {
    const base = scratch()
    const it = await claimed(base, Date.now() - 1000, [
      { status: 201, body: { token: 'fresh', exp: Date.now() + 3.6e6, deviceId: 'd' } },
    ])
    expect(await it.resume(PASSWORD)).toMatchObject({ ok: true })
    expect(it.sessionLive()).toBe(true)
    expect(loadAccount(base)?.session?.exp).toBeGreaterThan(Date.now())
  })

  it('carries 401 bad_credentials from a resume', async () => {
    const it = await claimed(scratch(), Date.now() - 1000, [
      { status: 401, body: { error: 'bad_credentials' } },
    ])
    expect(await it.resume('wrong-password-here')).toMatchObject({
      ok: false,
      reason: 'session-expired',
    })
  })

  it('verifies unlock offline against the claimed password', async () => {
    const it = await claimed(scratch(), Date.now() + 3.6e6, [])
    expect(it.verifyUnlock(PASSWORD)).toBe(true)
    expect(it.verifyUnlock('not-the-password')).toBe(false)
  })
})

describe('what a desktop registers, and what it never does', () => {
  const live = async (base: string, replies: readonly { status: number; body?: unknown }[]) => {
    const script = scriptedFetch([
      { status: 201, body: { ...CLAIMED, session: { token: 'tok', exp: Date.now() + 3.6e6 } } },
      ...replies,
    ])
    const it = new Accounts({ base, origin: ORIGIN, fetch: script.fetch })
    await it.claim({ username: 'drej', password: PASSWORD })
    return { it, script }
  }

  it('sends workspace ids and names only', async () => {
    const { it, script } = await live(scratch(), [{ status: 204 }])
    await it.registerDesktop([{ id: 'w1', name: 'Cookrew Dev' }])
    const body = JSON.parse(String(script.calls[1].body)) as {
      workspaces: { id: string; name: string }[]
    }
    expect(body.workspaces).toEqual([{ id: 'w1', name: 'Cookrew Dev' }])
  })

  it('sends NOTHING when the owner turned reachability off', async () => {
    const { it, script } = await live(scratch(), [{ status: 204 }])
    it.setWorkspacesReachable(false)
    await it.registerDesktop([{ id: 'w1', name: 'Cookrew Dev' }])
    const body = JSON.parse(String(script.calls[1].body)) as { workspaces: unknown[] }
    expect(body.workspaces).toEqual([])
  })

  it('returns the eight recovery codes and refuses a bodyless answer', async () => {
    const eight = ['A-1', 'B-2', 'C-3', 'D-4', 'E-5', 'F-6', 'G-7', 'H-8']
    const { it } = await live(scratch(), [{ status: 201, body: { codes: eight } }])
    expect(await it.recoveryCodes()).toMatchObject({ ok: true, value: eight })
    const { it: broken } = await live(scratch(), [{ status: 201, body: {} }])
    expect(await broken.recoveryCodes()).toMatchObject({ ok: false, reason: 'unknown' })
  })

  it('refuses to revoke the last device, with the registry’s reason', async () => {
    const { it } = await live(scratch(), [{ status: 409, body: { error: 'last_device' } }])
    expect(await it.revokeDevice('d1')).toMatchObject({ ok: false, reason: 'last_device' })
  })

  it('re-derives the local verifier only after cookrew.dev accepted the change', async () => {
    const base = scratch()
    const { it } = await live(base, [{ status: 204 }])
    expect(await it.setPassword({ current: PASSWORD, next: 'a-longer-passphrase' })).toMatchObject({
      ok: true,
    })
    expect(it.verifyUnlock('a-longer-passphrase')).toBe(true)
    expect(it.verifyUnlock(PASSWORD)).toBe(false)
  })

  it('keeps the old verifier when the registry refuses', async () => {
    const { it } = await live(scratch(), [{ status: 401, body: { error: 'bad_credentials' } }])
    await it.setPassword({ current: 'wrong-password-x', next: 'a-longer-passphrase' })
    expect(it.verifyUnlock(PASSWORD)).toBe(true)
  })

  it('answers no_account for every authed call on a local-only desktop', async () => {
    const local = new Accounts({ base: scratch(), origin: ORIGIN, fetch: () => Promise.reject() })
    expect(await local.profile()).toMatchObject({ ok: false, reason: 'no_account' })
    expect(await local.registerDesktop([])).toMatchObject({ ok: false, reason: 'no_account' })
    expect(local.verifyUnlock(PASSWORD)).toBe(false)
  })

  it('holds the minted batch in memory for the save dialog, and drops it after', async () => {
    const eight = ['A-1', 'B-2', 'C-3', 'D-4', 'E-5', 'F-6', 'G-7', 'H-8']
    const base = scratch()
    const { it } = await live(base, [{ status: 201, body: { codes: eight } }])
    expect(it.pendingRecoveryCodes()).toBeNull()
    await it.recoveryCodes()
    expect(it.pendingRecoveryCodes()).toEqual(eight)
    it.markRecoveryCodesSaved(1_757_000_000_000)
    // Dropped, so nothing can save a batch the owner already put away.
    expect(it.pendingRecoveryCodes()).toBeNull()
    expect(loadAccount(base)?.recoveryCodesSavedAt).toBe(1_757_000_000_000)
  })

  it('NEVER writes the codes to the account file', async () => {
    const eight = ['A-1', 'B-2', 'C-3', 'D-4', 'E-5', 'F-6', 'G-7', 'H-8']
    const base = scratch()
    const { it } = await live(base, [{ status: 201, body: { codes: eight } }])
    await it.recoveryCodes()
    it.markRecoveryCodesSaved()
    expect(readFileSync(accountFilePath(base), 'utf8')).not.toContain('A-1')
  })

  it('never writes the password into the file', async () => {
    const base = scratch()
    await live(base, [])
    expect(readFileSync(accountFilePath(base), 'utf8')).not.toContain(PASSWORD)
  })
})

describe('a 401 with a named refusal is that refusal, not a dead session', () => {
  it('a wrong authenticator code keeps its sentence; a bare 401 is a dead session', async () => {
    const sentence =
      'That is not the code showing right now. Wait for the next one and type it as it appears.'
    const script = scriptedFetch([
      { status: 201, body: { ...CLAIMED, session: { token: 'tok', exp: Date.now() + 3.6e6 } } },
      { status: 401, body: { error: 'bad_code', message: sentence } },
      { status: 401, body: { error: 'unauthenticated' } }
    ])
    const it = new Accounts({ base: scratch(), origin: ORIGIN, fetch: script.fetch })
    await it.claim({ username: 'drej', password: PASSWORD })
    const wrong = await it.call<void>('/v2/me/totp/confirm', { method: 'POST' })
    // NAMED now, not the catch-all: the ladder's refusals are in REFUSALS, so
    // the card can tell "type it again" from "start over" without reading the
    // sentence back.
    expect(wrong).toMatchObject({ ok: false, reason: 'bad_code', message: sentence })
    const dead = await it.call<void>('/v2/me', { method: 'GET' })
    expect(dead).toMatchObject({ ok: false, reason: 'session-expired' })
  })
})
