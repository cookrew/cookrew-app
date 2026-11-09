import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  Accounts,
  accountFilePath,
  deviceIdFor,
  loadAccount,
  mintDeviceKey,
  writeAccount,
  type AccountFile,
  type FetchLike,
} from '../src/main/account-v2'
import { accountHandlers, type AccountIpcDeps } from '../src/main/account-ipc'
import { IdleLock } from '../src/main/lock'
import { Requests } from '../src/main/requests'
import { Factors } from '../src/main/factors'
import { parseOAuthReturn, safeToOpen } from '../src/main/account-trip'
import { isAuthTranscript } from '../src/main/account-browser-auth'
import { AUDIENCE, DAY, FakeRegistry, NOW, ORIGIN, sha256, transcriptFor } from './support/fake-auth-site'

/**
 * THE DESKTOP'S HALF OF THE ONE SIGN-IN PAGE, against a fake registry.
 *
 * The registry is a fetch that answers the wire in src/shared/auth-site.ts and
 * checks what it is sent the way the real one does: the proof against the key
 * the request named, the verifier against the challenge. The browser is a
 * function that hands the code back through the scheme, as the OS would.
 */

let homes: string[] = []

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes = []
})

const home = (): string => {
  const made = mkdtempSync(path.join(tmpdir(), 'browser-auth-'))
  homes.push(made)
  return made
}

interface Mac {
  app: Accounts
  base: string
  registry: FakeRegistry
  opened: string[]
}

type Browser = (url: string, mac: Mac) => Promise<void> | void

/** The browser finishing at once: the code back through the scheme, with the trip's state. */
const finishes: Browser = (_url, m) => {
  const state = String(m.registry.opened?.state ?? '')
  m.app.oauthReturn(`cookrew://oauth#code=${m.registry.code}&state=${state}`)
}

function mac(browser: Browser = finishes, over: { base?: string; registry?: FakeRegistry } = {}): Mac {
  const base = over.base ?? home()
  const registry = over.registry ?? new FakeRegistry()
  const opened: string[] = []
  const held: { mac: Mac | null } = { mac: null }
  const app = new Accounts({
    base,
    origin: ORIGIN,
    deviceName: 'MacBook Pro',
    fetch: registry.fetch,
    now: () => NOW,
    openBrowser: async (url) => {
      opened.push(url)
      if (held.mac !== null) await browser(url, held.mac)
    },
  })
  held.mac = { app, base, registry, opened }
  return held.mac
}

/** An account already on this Mac, with its session alive or ended. */
function withAccount(live: boolean, over: Partial<AccountFile> = {}): { base: string; file: AccountFile } {
  const base = home()
  const keys = mintDeviceKey()
  const file: AccountFile = {
    username: 'octo',
    deviceId: deviceIdFor(keys.publicKeyJwk),
    kind: 'desktop',
    name: 'MacBook Pro',
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
    registry: ORIGIN,
    session: { token: 'tok-old', exp: live ? NOW + DAY : NOW - DAY },
    unlock: null,
    lockAfterMs: 900_000,
    claimedAt: NOW - DAY,
    workspacesReachable: true,
    recoveryCodesSavedAt: null,
    ...over,
  }
  writeAccount(file, base)
  return { base, file }
}

describe('the return', () => {
  it('takes a code in place of a handoff, and exactly one of code, handoff and error', () => {
    expect(parseOAuthReturn('cookrew://oauth#code=a&state=b')).toEqual({ handoff: null, error: null, state: 'b', code: 'a' })
    expect(parseOAuthReturn('cookrew://oauth#handoff=a&state=b')).toEqual({ handoff: 'a', error: null, state: 'b' })
    expect(parseOAuthReturn('cookrew://oauth#error=expired&state=b')).toEqual({ handoff: null, error: 'expired', state: 'b' })
    expect(parseOAuthReturn('cookrew://oauth#code=a&handoff=b&state=c')).toBeNull()
    expect(parseOAuthReturn('cookrew://oauth#code=a&error=denied&state=c')).toBeNull()
    expect(parseOAuthReturn('cookrew://oauth#code=a')).toBeNull()
    expect(parseOAuthReturn('cookrew://oauth?code=a&state=b')).toBeNull()
  })

  it('opens https anywhere and plain http only on this machine', () => {
    expect(safeToOpen('https://auth.cookrew.dev/?request=x')).toBe(true)
    expect(safeToOpen('http://auth.localhost:8790/?request=x')).toBe(true)
    expect(safeToOpen('http://127.0.0.1:8790/')).toBe(true)
    expect(safeToOpen('http://localhost:8790/')).toBe(true)
    expect(safeToOpen('http://auth.cookrew.dev/')).toBe(false)
    expect(safeToOpen('http://localhost.evil.dev/')).toBe(false)
    expect(safeToOpen('file:///etc/passwd')).toBe(false)
    expect(safeToOpen('https://user:pw@auth.cookrew.dev/')).toBe(false)
    expect(safeToOpen(42)).toBe(false)
  })

  it('signs only an auth transcript for this request', () => {
    expect(isAuthTranscript(transcriptFor('req-1', 'd'), 'req-1')).toBe(true)
    expect(isAuthTranscript(transcriptFor('req-2', 'd'), 'req-1')).toBe(false)
    expect(isAuthTranscript('cookrew-hello/v1\ndevice:d\nnonce:n', 'req-1')).toBe(false)
    expect(isAuthTranscript('{"reach":true}', 'req-1')).toBe(false)
  })
})

describe('signing in through the browser, on a Mac with no account', () => {
  it('asks for a request naming a fresh key, proves it, opens the page and lands the code', async () => {
    const m = mac()
    const answer = await m.app.browserSignIn('sign-in')
    expect(answer.ok).toBe(true)

    const asked = m.registry.opened as Record<string, unknown>
    expect(asked).toMatchObject({ client: 'desktop', intent: 'sign-in', back: { scheme: true } })
    expect(typeof (asked.back as { port?: unknown }).port).toBe('number')
    expect(asked.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(asked.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(asked).not.toHaveProperty('username')
    const device = asked.device as { id: string; kind: string; name: string; jwk: Record<string, unknown> }
    expect(device).toMatchObject({ kind: 'desktop', name: 'MacBook Pro' })
    expect(device.id).toBe(deviceIdFor(device.jwk))
    expect(device.jwk).not.toHaveProperty('d')

    // The signature verified against the key the request named, before the browser opened.
    expect(m.registry.proofs).toEqual([true])
    expect(m.opened).toEqual([`${AUDIENCE}/?request=req-1`])
    // The redeem carried the code and the verifier behind the challenge, and nothing else.
    const [spent] = m.registry.calls('/v2/auth/token')
    expect(Object.keys(spent.body).sort()).toEqual(['code', 'verifier'])
    expect(sha256(String(spent.body.verifier))).toBe(asked.challenge)

    const file = loadAccount(m.base)
    expect(file).toMatchObject({ username: 'octo', deviceId: device.id, unlock: null, passwordless: true })
    expect(file?.unlockBy).toBeUndefined()
    expect(m.app.lockWaits()).toBe('set-password')
    expect(file?.publicKeyJwk).toEqual(device.jwk)
    expect(file?.session?.token).toBe('tok-new')
  })

  it('an account with a password typed on the page asks nothing here: the first unlock takes it', async () => {
    const m = mac()
    m.registry.hasPassword = true
    expect((await m.app.browserSignIn('sign-in')).ok).toBe(true)
    const file = loadAccount(m.base)
    expect(file).toMatchObject({ unlock: null })
    expect(file?.unlockBy).toBeUndefined()
    expect(file?.passwordless).toBeUndefined()
    expect(m.app.lockWaits()).toBeNull()
    expect(m.app.passwordPending()).toBe(true)
  })

  it('names the screen to open on, and a prefill when there is one', async () => {
    for (const intent of ['create', 'github', 'google'] as const) {
      const m = mac()
      expect((await m.app.browserSignIn(intent)).ok).toBe(true)
      expect(m.registry.opened?.intent).toBe(intent)
    }
    const m = mac()
    await m.app.browserSignIn('sign-in', { username: 'octo' })
    expect(m.registry.opened?.username).toBe('octo')
  })

  it('comes back through the loopback listener as well as the scheme', async () => {
    const m = mac(async (_url, at) => {
      const asked = at.registry.opened as { state: string; back: { port: number } }
      const back = `http://127.0.0.1:${asked.back.port}/oauth/return?code=${at.registry.code}&state=${asked.state}`
      expect((await fetch(back)).status).toBe(200)
    })
    expect((await m.app.browserSignIn('sign-in')).ok).toBe(true)
    expect(loadAccount(m.base)?.username).toBe('octo')
  })

  it('drops a return it did not start and waits for the real one', async () => {
    let dropped: boolean | null = null
    const m = mac((url, at) => {
      dropped = at.app.oauthReturn(`cookrew://oauth#code=${at.registry.code}&state=${'x'.repeat(43)}`)
      finishes(url, at)
    })
    expect((await m.app.browserSignIn('sign-in')).ok).toBe(true)
    expect(dropped).toBe(false)
    expect(m.registry.calls('/v2/auth/token')).toHaveLength(1)
  })

  it('a refusal on the page is a cancel or a cold trip, and writes nothing', async () => {
    for (const [error, reason] of [
      ['denied', 'cancelled'],
      ['expired', 'expired'],
    ] as const) {
      const m = mac((_url, at) => {
        at.app.oauthReturn(`cookrew://oauth#error=${error}&state=${String(at.registry.opened?.state)}`)
      })
      expect(await m.app.browserSignIn('sign-in')).toMatchObject({ ok: false, reason })
      expect(m.registry.calls('/v2/auth/token')).toHaveLength(0)
      expect(existsSync(accountFilePath(m.base))).toBe(false)
    }
  })

  it('cancelling from the app ends the wait, and no code is ever spent', async () => {
    const m = mac(() => undefined)
    const waiting = m.app.browserSignIn('sign-in')
    await vi.waitFor(() => expect(m.app.providerTripping()).toBe(true))
    expect(m.app.providerCancel()).toBe(true)
    expect(await waiting).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(m.registry.calls('/v2/auth/token')).toHaveLength(0)
  })

  it('a code the registry will not spend is a refusal, and writes nothing', async () => {
    const m = mac()
    m.registry.redeem = () => Response.json({ error: 'bad_credentials' }, { status: 401 })
    expect(await m.app.browserSignIn('sign-in')).toMatchObject({ ok: false, reason: 'bad_credentials' })
    const cold = mac()
    cold.registry.redeem = () => Response.json({ error: 'flow_over', why: 'expired' }, { status: 410 })
    expect(await cold.app.browserSignIn('sign-in')).toMatchObject({ ok: false, reason: 'expired' })
    expect(existsSync(accountFilePath(m.base))).toBe(false)
    expect(existsSync(accountFilePath(cold.base))).toBe(false)
  })
})

describe('a registry that predates the page', () => {
  it.each([
    ['a 404', () => new Response('Not found', { status: 404 })],
    ['a 405', () => new Response(null, { status: 405 })],
    ['a 501', () => Response.json({ error: 'not_implemented' }, { status: 501 })],
    ['a page in place of JSON', () => new Response('<!doctype html><title>cookrew.dev</title>', { status: 200 })],
  ])('answers unsupported on %s, before any proof or browser', async (_name, answer) => {
    const m = mac()
    m.registry.requests = answer
    expect(await m.app.browserSignIn('sign-in')).toEqual({ ok: false, reason: 'unsupported' })
    expect(m.registry.seen.map((seen) => seen.path)).toEqual(['/v2/auth/requests'])
    expect(m.opened).toEqual([])
    expect(m.app.providerTripping()).toBe(false)
  })

  it('a registry that is down is offline, not unsupported', async () => {
    const m = mac()
    const app = new Accounts({ base: m.base, origin: ORIGIN, fetch: () => Promise.reject(new Error('down')), now: () => NOW })
    expect(await app.browserSignIn('sign-in')).toMatchObject({ ok: false, reason: 'offline' })
  })
})

describe('what is never done', () => {
  it('signs nothing that is not an auth transcript for this request', async () => {
    const m = mac()
    m.registry.transcript = 'cookrew-hello/v1\ndevice:x\nnonce:y'
    expect(await m.app.browserSignIn('sign-in')).toMatchObject({ ok: false, reason: 'unknown' })
    expect(m.registry.calls('/v2/auth/requests/req-1/proof')).toHaveLength(0)
    expect(m.opened).toEqual([])
  })

  it('opens no address but https or this machine', async () => {
    for (const hostile of ['file:///etc/passwd', 'http://auth.cookrew.dev/?request=req-1', 'javascript:alert(1)']) {
      const m = mac()
      m.registry.authorizeUrl = hostile
      expect(await m.app.browserSignIn('sign-in')).toMatchObject({ ok: false, reason: 'unknown' })
      expect(m.opened).toEqual([])
    }
    const local = mac()
    local.registry.authorizeUrl = 'http://auth.localhost:8790/?request=req-1'
    expect((await local.app.browserSignIn('sign-in')).ok).toBe(true)
    expect(local.opened).toEqual(['http://auth.localhost:8790/?request=req-1'])
  })

  it('a refused proof never opens the browser, and says the registry sentence', async () => {
    const registry = new FakeRegistry()
    const refusing: FetchLike = async (input, init) =>
      String(input).endsWith('/proof')
        ? Response.json({ error: 'bad_proof', message: 'This device could not prove its key. Start again.' }, { status: 403 })
        : registry.fetch(input, init)
    const opened: string[] = []
    const app = new Accounts({ base: home(), origin: ORIGIN, fetch: refusing, now: () => NOW, openBrowser: (url) => void opened.push(url) })
    expect(await app.browserSignIn('sign-in')).toMatchObject({
      ok: false,
      message: 'This device could not prove its key. Start again.',
    })
    expect(opened).toEqual([])
  })
})

describe('resuming an ended session through the browser', () => {
  it('offers the held device and the account name, and replaces only the session', async () => {
    const { base, file } = withAccount(false)
    const m = mac(finishes, { base })
    expect(m.app.sessionLive()).toBe(false)
    expect((await m.app.browserResume()).ok).toBe(true)
    expect(m.registry.opened).toMatchObject({ client: 'desktop', intent: 'sign-in', username: 'octo' })
    expect(m.registry.opened?.device).toEqual({ id: file.deviceId, kind: 'desktop', name: 'MacBook Pro', jwk: file.publicKeyJwk })
    expect(m.registry.proofs).toEqual([true])
    const after = loadAccount(base)
    expect(after).toMatchObject({ username: 'octo', deviceId: file.deviceId, unlock: null })
    expect(after?.unlockBy).toBeUndefined()
    expect(after?.privateKeyJwk).toEqual(file.privateKeyJwk)
    expect(after?.session?.token).toBe('tok-new')
    expect(m.app.sessionLive()).toBe(true)
  })

  it('refuses a different account and changes nothing', async () => {
    const { base } = withAccount(false)
    const before = readFileSync(accountFilePath(base), 'utf8')
    const m = mac(finishes, { base })
    m.registry.username = 'someone-else'
    expect(await m.app.browserResume()).toMatchObject({ ok: false, reason: 'wrong_identity' })
    expect(readFileSync(accountFilePath(base), 'utf8')).toBe(before)
  })

  it('needs an account to resume', async () => {
    expect(await mac().app.browserResume()).toMatchObject({ ok: false, reason: 'no_account' })
  })
})

describe('linking a provider through the browser', () => {
  it('sends the fresh proof under the session and answers linked', async () => {
    const { base, file } = withAccount(true)
    const m = mac(finishes, { base })
    expect(await m.app.browserLink('google', { current: 'the password' })).toEqual({ ok: true, value: undefined })
    const [asked] = m.registry.calls('/v2/auth/requests')
    expect(asked.auth).toBe('Bearer tok-old')
    expect(asked.body).toMatchObject({ client: 'desktop', intent: 'link', provider: 'google', current: 'the password' })
    expect((asked.body.device as { id: string }).id).toBe(file.deviceId)
    expect(m.registry.proofs).toEqual([true])
    expect(m.registry.calls('/v2/auth/token')[0].auth).toBe('Bearer tok-old')
  })

  it('carries a step-up id in place of a password', async () => {
    const { base } = withAccount(true)
    const m = mac(finishes, { base })
    expect((await m.app.browserLink('github', { stepUp: 'su-1' })).ok).toBe(true)
    expect(m.registry.opened).toMatchObject({ intent: 'link', provider: 'github', stepUp: 'su-1' })
    expect(m.registry.opened).not.toHaveProperty('current')
  })

  it('an old registry answers unsupported and is asked nothing more', async () => {
    const { base } = withAccount(true)
    const m = mac(finishes, { base })
    m.registry.requests = () => new Response('Not found', { status: 404 })
    expect(await m.app.browserLink('github', { current: 'pw' })).toEqual({ ok: false, reason: 'unsupported' })
    expect(m.registry.seen).toHaveLength(1)
  })
})

describe('adding a passkey through the browser', () => {
  it('opens a passkey request under the session, for this Mac, and spends the code with it', async () => {
    const { base, file } = withAccount(true)
    const m = mac(finishes, { base })
    expect(await m.app.browserAddPasskey()).toEqual({ ok: true, value: { id: 'pk-1', name: 'Touch ID on this Mac', addedAt: NOW } })
    const [asked] = m.registry.calls('/v2/auth/requests')
    expect(asked.auth).toBe('Bearer tok-old')
    expect(asked.body).toMatchObject({ client: 'desktop', intent: 'passkey', back: { scheme: true } })
    // No proof travels from here: the page runs the account's own step-up.
    expect(asked.body).not.toHaveProperty('current')
    expect(asked.body).not.toHaveProperty('stepUp')
    expect((asked.body.device as { id: string }).id).toBe(file.deviceId)
    expect(m.registry.proofs).toEqual([true])
    expect(m.opened).toEqual(['https://auth.cookrew.dev/?request=req-1'])
    expect(m.registry.calls('/v2/auth/token')[0].auth).toBe('Bearer tok-old')
  })

  it('a page cancelled there is a cancel, not a failure', async () => {
    const { base } = withAccount(true)
    const m = mac(finishes, { base })
    m.registry.over = 'denied'
    expect(await m.app.browserAddPasskey()).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('the registry’s refusal reaches the card in its own words', async () => {
    const { base } = withAccount(true)
    const m = mac(finishes, { base })
    m.registry.redeem = () =>
      Response.json({ error: 'passkey_known', message: 'That passkey is already enrolled.' }, { status: 409 })
    expect(await m.app.browserAddPasskey()).toMatchObject({ ok: false, message: 'That passkey is already enrolled.' })
  })

  it('an old registry answers unsupported and is asked nothing more; no account asks nothing at all', async () => {
    const { base } = withAccount(true)
    const m = mac(finishes, { base })
    m.registry.requests = () => new Response('Not found', { status: 404 })
    expect(await m.app.browserAddPasskey()).toEqual({ ok: false, reason: 'unsupported' })
    expect(m.registry.seen).toHaveLength(1)
    const bare = mac()
    expect(await bare.app.browserAddPasskey()).toEqual({ ok: false, reason: 'no_account' })
    expect(bare.registry.seen).toHaveLength(0)
  })
})

describe('the IPC', () => {
  function wired(m: Mac): { deps: AccountIpcDeps; handlers: ReturnType<typeof accountHandlers> } {
    // Armed regardless of the passcode, so a test can lock it.
    const lock = new IdleLock({ lockAfterMs: 60_000, verify: () => false, armed: () => true })
    const deps: AccountIpcDeps = {
      accounts: m.app,
      lock,
      requests: new Requests({ accounts: m.app, notify: () => undefined }),
      factors: new Factors({ accounts: m.app, registry: ORIGIN }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false }),
    }
    return { deps, handlers: accountHandlers(deps) }
  }

  it('a browser sign-in answers the status, and refuses a screen it does not know', async () => {
    const m = mac()
    const { deps, handlers } = wired(m)
    expect(await handlers['account:browserSignIn']('link')).toMatchObject({ ok: false, reason: 'not_offered' })
    expect(await handlers['account:browserSignIn']('github')).toMatchObject({ ok: true, value: { username: 'octo' } })
    expect(m.registry.opened?.intent).toBe('github')
    deps.requests.stop()
  })

  it('adds a passkey through the page, and not from behind the lock', async () => {
    const { base } = withAccount(true)
    const m = mac(finishes, { base })
    const { deps, handlers } = wired(m)
    expect(await handlers['account:passkeyBrowser']()).toMatchObject({ ok: true, value: { id: 'pk-1' } })
    deps.lock.lock()
    const before = m.registry.seen.length
    expect(await handlers['account:passkeyBrowser']()).toMatchObject({ ok: false, reason: 'locked' })
    expect(m.registry.seen).toHaveLength(before)
    deps.requests.stop()
  })

  it('nothing goes to the browser from behind the lock', async () => {
    const { base } = withAccount(false)
    const m = mac(finishes, { base })
    const { deps, handlers } = wired(m)
    deps.lock.lock()
    expect(await handlers['account:browserResume']()).toMatchObject({ ok: false, reason: 'locked' })
    expect(m.registry.seen).toHaveLength(0)
    deps.requests.stop()
  })

  it('a resume answers the status, and a lock that closed meanwhile stays closed', async () => {
    const { base } = withAccount(false)
    const later: { lock: IdleLock | null } = { lock: null }
    const m = mac(
      (url, at) => {
        // The person walked away while the page was open: a signed-in browser
        // answering is no proof anybody is at this keyboard.
        later.lock?.lock()
        finishes(url, at)
      },
      { base },
    )
    const { deps, handlers } = wired(m)
    later.lock = deps.lock
    expect(await handlers['account:browserResume']()).toMatchObject({ ok: true, value: { username: 'octo', sessionExpired: false } })
    expect(deps.lock.locked).toBe(true)
    deps.requests.stop()
  })

  it('a link goes through the browser, and an old registry falls back to the provider trip with the same proof', async () => {
    const { base } = withAccount(true)
    const fresh = mac(finishes, { base })
    const one = wired(fresh)
    expect(await one.handlers['account:browserLink']({ provider: 'google', current: 'pw' })).toEqual({ ok: true, value: undefined })
    expect(fresh.registry.calls('/v2/oauth/google/start')).toHaveLength(0)
    one.deps.requests.stop()

    const old = mac(
      (_url, at) => {
        at.app.oauthReturn(`cookrew://oauth#handoff=h-1&state=${String(at.registry.legacyState)}`)
      },
      { base },
    )
    old.registry.requests = () => new Response('Not found', { status: 404 })
    const two = wired(old)
    expect(await two.handlers['account:browserLink']({ provider: 'google', current: 'pw' })).toEqual({ ok: true, value: undefined })
    const [legacy] = old.registry.calls('/v2/oauth/google/start')
    expect(legacy.body).toMatchObject({ intent: 'link', current: 'pw' })
    expect(old.registry.calls('/v2/oauth/redeem')).toHaveLength(1)
    two.deps.requests.stop()
  })
})

describe('the terminal: a code to type, and a poll', () => {
  it('asks as cli, shows the code, tries the browser, and lands after the page finishes', async () => {
    const m = mac()
    const failing = new Accounts({
      base: m.base,
      origin: ORIGIN,
      deviceName: 'Linux · box',
      fetch: m.registry.fetch,
      now: () => NOW,
      openBrowser: (url) => {
        m.opened.push(url)
        return Promise.reject(new Error('no browser on this box'))
      },
    })
    m.registry.pending = 2
    const shown: unknown[] = []
    const answer = await failing.browserTerminalSignIn({ onCode: (code) => shown.push(code), everyMs: 1 })
    expect(answer.ok).toBe(true)
    expect(m.registry.opened).toMatchObject({ client: 'cli', intent: 'sign-in' })
    expect(m.registry.opened).not.toHaveProperty('state')
    expect(m.registry.opened).not.toHaveProperty('back')
    expect(m.registry.proofs).toEqual([true])
    expect(shown).toEqual([
      {
        userCode: 'BCDF-GHJK',
        verificationUri: `${AUDIENCE}/device`,
        verificationUriComplete: null,
        expiresAt: NOW + 600_000,
      },
    ])
    await vi.waitFor(() => expect(m.opened).toEqual([`${AUDIENCE}/device`]))
    const polls = m.registry.calls('/v2/auth/token')
    expect(polls).toHaveLength(3)
    expect(Object.keys(polls[0].body).sort()).toEqual(['request', 'verifier'])
    expect(polls[0].body.request).toBe('req-1')
    expect(loadAccount(m.base)).toMatchObject({ username: 'octo', name: 'Linux · box' })
    expect(loadAccount(m.base)?.unlockBy).toBeUndefined()
  })

  it('says denied and expired apart', async () => {
    for (const over of ['denied', 'expired'] as const) {
      const m = mac()
      m.registry.over = over
      expect(await m.app.browserTerminalSignIn({ onCode: () => undefined, everyMs: 1 })).toMatchObject({ ok: false, reason: over })
      expect(existsSync(accountFilePath(m.base))).toBe(false)
    }
  })

  it('stops when the terminal goes', async () => {
    const m = mac()
    m.registry.pending = Number.MAX_SAFE_INTEGER
    const stop = new AbortController()
    const waiting = m.app.browserTerminalSignIn({ onCode: () => undefined, everyMs: 1, signal: stop.signal })
    await vi.waitFor(() => expect(m.registry.calls('/v2/auth/token').length).toBeGreaterThan(1))
    stop.abort()
    expect(await waiting).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  it('an old registry answers unsupported, and nothing is shown', async () => {
    const m = mac()
    m.registry.requests = () => new Response('Not found', { status: 404 })
    const shown: unknown[] = []
    expect(await m.app.browserTerminalSignIn({ onCode: (code) => shown.push(code) })).toEqual({ ok: false, reason: 'unsupported' })
    expect(shown).toEqual([])
  })
})
