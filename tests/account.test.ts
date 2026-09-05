import { describe, expect, it } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AccountError,
  accountFile,
  checkHandle,
  currentAccount,
  loadAccount,
  mintAccount,
  normaliseHandle,
  openAccount,
  resolveServingHandle,
  suggestHandle,
  writeAccount,
  type AccountFile
} from '../src/main/account'
import { bindMessage, jwkThumbprint } from '../src/main/registry-assertion'

const REGISTRY = 'https://registry.test'

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cookrew-account-'))
}

/** A registry that is a table of answers, and a log of what was asked. */
function fakeRegistry(
  routes: Record<string, (input: { body: unknown; headers: Headers; method: string }) => Response>
): { fetch: typeof globalThis.fetch; calls: { url: string; body: unknown; bearer?: string }[] } {
  const calls: { url: string; body: unknown; bearer?: string }[] = []
  const fetchStub = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers ?? {})
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const body = raw === undefined ? undefined : JSON.parse(raw)
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '')
    calls.push({ url: `${method} ${url.pathname}`, body, ...(bearer ? { bearer } : {}) })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) return new Response('{}', { status: 404 })
    return route({ body, headers, method })
  }) as typeof globalThis.fetch
  return { fetch: fetchStub, calls }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A token body the way the registry writes one: base64url(claims).sig. */
const tokenWith = (claims: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`

const mintRoutes = (
  extra: Record<string, (input: { body: unknown; headers: Headers; method: string }) => Response> = {}
): Record<string, (input: { body: unknown; headers: Headers; method: string }) => Response> => ({
  'POST /v1/accounts': () => json(201, { handle: 'mira', deviceId: 'd_abc' }),
  'POST /v1/identity/challenge': () => json(200, { challenge: 'nonce-1' }),
  'POST /v1/identity/assert': () =>
    json(200, { token: tokenWith({ sub: 'mira', dev: 'd_abc', scope: 'account', exp: 2e12 }) }),
  ...extra
})

async function mintInto(dir: string, fetchStub: typeof globalThis.fetch): Promise<AccountFile> {
  return mintAccount({ handle: 'mira', registry: REGISTRY, baseDir: dir, fetch: fetchStub })
}

describe('the account file', () => {
  it('mints one account, written owner-only', async () => {
    const dir = freshDir()
    const { fetch: f } = fakeRegistry(mintRoutes())
    const account = await mintInto(dir, f)

    expect(account.handle).toBe('mira')
    expect(account.deviceId).toBe('d_abc')
    expect(account.kind).toBe('desktop')
    expect(account.registry).toBe(REGISTRY)
    expect(loadAccount(dir)?.handle).toBe('mira')
    if (process.platform !== 'win32') {
      expect(statSync(accountFile(dir)).mode & 0o777).toBe(0o600)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends the device key, not the private half', async () => {
    const dir = freshDir()
    const { fetch: f, calls } = fakeRegistry(mintRoutes())
    await mintInto(dir, f)
    const sent = calls[0].body as { device: { jwk: Record<string, unknown>; kind: string } }
    expect(sent.device.kind).toBe('desktop')
    expect(sent.device.jwk.kty).toBe('OKP')
    // `d` is the private scalar. It must never cross the wire.
    expect(sent.device.jwk.d).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a taken handle by NAME, so the sheet can say which one', async () => {
    const dir = freshDir()
    const { fetch: f } = fakeRegistry({
      'POST /v1/accounts': () => json(409, { error: 'taken' })
    })
    await expect(mintInto(dir, f)).rejects.toMatchObject({ reason: 'handle-taken' })
    // NOTHING is written on a refusal: a machine that believed it owned a name
    // the registry gave away would fail later, on signatures, not on the name.
    expect(loadAccount(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a name that is not a handle before asking anyone', async () => {
    const dir = freshDir()
    const { fetch: f, calls } = fakeRegistry(mintRoutes())
    await expect(
      mintAccount({ handle: 'Not A Handle', registry: REGISTRY, baseDir: dir, fetch: f })
    ).rejects.toBeInstanceOf(AccountError)
    expect(calls).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a corrupt file as NO account rather than overwriting it', () => {
    const dir = freshDir()
    writeFileSync(accountFile(dir), 'not json', { mode: 0o600 })
    expect(loadAccount(dir)).toBeNull()
    // The bytes are still there — the handle they name may be the only claim.
    expect(readFileSync(accountFile(dir), 'utf8')).toBe('not json')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('checkHandle', () => {
  const availability = async (status: number): Promise<string> => {
    const { fetch: f } = fakeRegistry({
      'HEAD /v1/accounts/mira': () => new Response(null, { status })
    })
    return checkHandle('@Mira ', { registry: REGISTRY, fetch: f })
  }

  it('reads 200 as taken and 404 as free', async () => {
    expect(await availability(200)).toBe('taken')
    expect(await availability(404)).toBe('free')
  })

  it('says UNKNOWN when the registry cannot be asked — never an optimistic free', async () => {
    const f = (async () => {
      throw new Error('offline')
    }) as typeof globalThis.fetch
    expect(await checkHandle('mira', { registry: REGISTRY, fetch: f })).toBe('unknown')
    expect(await availability(500)).toBe('unknown')
  })

  it('rejects a bad shape without a round trip', async () => {
    const { fetch: f, calls } = fakeRegistry({})
    expect(await checkHandle('-nope-', { registry: REGISTRY, fetch: f })).toBe('invalid')
    expect(calls).toHaveLength(0)
  })
})

describe('suggestHandle', () => {
  it('folds an OS username into a handle, and gives up rather than guess', () => {
    expect(suggestHandle('Drej.Smith')).toBe('drej-smith')
    expect(suggestHandle('root')).toBe('root')
    expect(suggestHandle('...')).toBe('')
    expect(normaliseHandle(' @Mira ')).toBe('mira')
  })
})

describe('the account speaking to its registry', () => {
  it('asserts with scope, aud and the DEVICE id — the handle names the account', async () => {
    const dir = freshDir()
    const { fetch: f, calls } = fakeRegistry(mintRoutes())
    const stored = await mintInto(dir, f)
    const session = openAccount(stored, { fetch: f })

    const token = await session.token('call', '@drej/alpha')
    expect(token).toContain('.')
    const asserted = calls.find((c) => c.url === 'POST /v1/identity/assert')?.body as Record<
      string,
      unknown
    >
    expect(asserted.scope).toBe('call')
    expect(asserted.aud).toBe('@drej/alpha')
    expect(asserted.device).toBe('d_abc')
    expect(asserted.credentialId).toBe('mira')
    expect(typeof asserted.signature).toBe('string')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reuses a token that still has time on it', async () => {
    const dir = freshDir()
    const { fetch: f, calls } = fakeRegistry(mintRoutes())
    const session = openAccount(await mintInto(dir, f), { fetch: f, now: () => 1000 })
    await session.token('account')
    await session.token('account')
    expect(calls.filter((c) => c.url === 'POST /v1/identity/assert')).toHaveLength(1)
    // A different scope is a different token and is minted afresh.
    await session.token('serve')
    expect(calls.filter((c) => c.url === 'POST /v1/identity/assert')).toHaveLength(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('vouches for a device with a signature anyone can check', async () => {
    const dir = freshDir()
    const { fetch: f } = fakeRegistry(mintRoutes())
    const stored = await mintInto(dir, f)
    const session = openAccount(stored, { fetch: f })

    const phone = { id: 'd_phone', jwk: stored.publicKeyJwk, kind: 'phone' as const, name: 'iPhone' }
    const vouch = session.vouchFor(phone)
    const holds = verify(
      null,
      Buffer.from(bindMessage('mira', 'd_phone', jwkThumbprint(stored.publicKeyJwk)), 'utf8'),
      createPublicKey({ key: stored.publicKeyJwk as never, format: 'jwk' }),
      Buffer.from(vouch, 'base64url')
    )
    expect(holds).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('binds a device with an account token and the vouch beside it', async () => {
    const dir = freshDir()
    const { fetch: f, calls } = fakeRegistry(
      mintRoutes({
        'POST /v1/accounts/@mira/devices': () => json(201, { deviceId: 'd_phone' })
      })
    )
    const stored = await mintInto(dir, f)
    const session = openAccount(stored, { fetch: f })
    const bound = await session.bindDevice({
      id: 'd_phone',
      jwk: stored.publicKeyJwk,
      kind: 'phone',
      name: 'iPhone'
    })

    expect(bound).toEqual({ handle: 'mira', deviceId: 'd_phone' })
    const bind = calls.find((c) => c.url === 'POST /v1/accounts/@mira/devices')
    expect(bind?.bearer).toBeTruthy()
    expect((bind?.body as { vouch: string }).vouch).toBeTruthy()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists, revokes and asks for a link code', async () => {
    const dir = freshDir()
    const { fetch: f, calls } = fakeRegistry(
      mintRoutes({
        'GET /v1/accounts/@mira/devices': () =>
          json(200, { devices: [{ id: 'd_abc', kind: 'desktop', name: 'MacBook' }] }),
        'DELETE /v1/accounts/@mira/devices/d_phone': () => json(200, { ok: true }),
        'POST /v1/accounts/@mira/link-codes': () => json(200, { code: 'AB12CD', exp: 42 })
      })
    )
    const session = openAccount(await mintInto(dir, f), { fetch: f })

    expect(await session.listDevices()).toHaveLength(1)
    expect(await session.revokeDevice('d_phone')).toBe(true)
    expect(await session.linkCode()).toEqual({ code: 'AB12CD', exp: 42 })
    expect(calls.some((c) => c.url === 'DELETE /v1/accounts/@mira/devices/d_phone')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('names a revoked device plainly when the registry refuses the sign-in', async () => {
    const dir = freshDir()
    const { fetch: f } = fakeRegistry(
      mintRoutes({ 'POST /v1/identity/assert': () => json(401, {}) })
    )
    const session = openAccount(await mintInto(dir, f), { fetch: f })
    await expect(session.token('account')).rejects.toThrow(/revoked/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('currentAccount is null on a first run and the account after a mint', async () => {
    const dir = freshDir()
    expect(currentAccount({ baseDir: dir })).toBeNull()
    const { fetch: f } = fakeRegistry(mintRoutes())
    await mintInto(dir, f)
    expect(currentAccount({ baseDir: dir, fetch: f })?.handle).toBe('mira')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolveServingHandle — the env is an override, never a mint', () => {
  const account = { handle: 'mira' }

  it('serves as the minted account when the env agrees or is unset', () => {
    expect(resolveServingHandle(account, undefined)).toEqual({ ok: true, handle: 'mira' })
    expect(resolveServingHandle(account, '@Mira')).toEqual({ ok: true, handle: 'mira' })
  })

  it('REFUSES a mismatch out loud rather than picking a side', () => {
    const verdict = resolveServingHandle(account, 'someone-else')
    expect(verdict.ok).toBe(false)
    // Both names appear: the sentence has to be actionable in a terminal.
    expect(verdict.ok === false && verdict.reason).toContain('@someone-else')
    expect(verdict.ok === false && verdict.reason).toContain('@mira')
  })

  it('refuses to serve with no account at all, env or no env', () => {
    expect(resolveServingHandle(null, 'anything').ok).toBe(false)
    const bare = resolveServingHandle(null, undefined)
    expect(bare.ok === false && bare.reason).toContain('has not minted a username')
  })
})

describe('writeAccount', () => {
  it('round-trips through the file the app actually reads', () => {
    const dir = freshDir()
    const written = writeAccount(
      {
        handle: 'drej',
        deviceId: 'd_1',
        kind: 'desktop',
        name: 'MacBook',
        privateKeyJwk: { kty: 'OKP' },
        publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'aaa' },
        registry: REGISTRY,
        mintedAt: '2026-09-05T00:00:00.000Z'
      },
      dir
    )
    expect(loadAccount(dir)).toEqual(written)
    rmSync(dir, { recursive: true, force: true })
  })
})
