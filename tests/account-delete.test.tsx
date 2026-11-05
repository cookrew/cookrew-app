// DELETING THE ACCOUNT FROM THE APP. The order is the rule, as it is for signing
// out: cookrew.dev says 204 first, and only then is account.json removed here.
// A refusal leaves the file exactly as it was.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Accounts, DEFAULT_LOCK_AFTER_MS, writeAccount } from '../src/main/account-v2'
import { accountHandlers, type AccountIpcDeps } from '../src/main/account-ipc'
import { Factors } from '../src/main/factors'
import { Requests } from '../src/main/requests'
import { IdleLock } from '../src/main/lock'
import { DeleteAccountRow } from '../src/renderer/src/account/DeleteAccountRow'
import { DELETE_ACCOUNT_KEEPS, DELETE_ACCOUNT_TAKES } from '../src/shared/account-delete'
import { fakeAccount, tempBase } from './support/idv2'

const PASSWORD = 'correct horse battery staple'

let server: Server
let origin = ''
let asked: { method: string; url: string; body: string }[] = []
let answer = { status: 204, body: '' }
/** What one route answers, when it differs from `answer`. */
let routes: Record<string, { status: number; body: string }> = {}
const cleanups: (() => void)[] = []

beforeEach(async () => {
  asked = []
  answer = { status: 204, body: '' }
  routes = {}
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      asked.push({ method: request.method ?? '', url: request.url ?? '', body })
      const reply = routes[`${request.method} ${request.url}`] ?? answer
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const clean of cleanups.splice(0)) clean()
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

function signedInMac(): { base: string; accounts: Accounts } {
  const { base, clean } = tempBase()
  cleanups.push(clean)
  writeAccount(fakeAccount({ registry: origin }), base)
  return { base, accounts: new Accounts({ base, origin }) }
}

describe('Accounts.deleteAccount', () => {
  it('sends the name and the proof, then removes the file', async () => {
    const { base, accounts } = signedInMac()
    expect(await accounts.deleteAccount(PASSWORD, 'drej')).toEqual({ ok: true, value: undefined })
    const sent = asked.find((a) => a.method === 'DELETE')
    expect(sent?.url).toBe('/v2/me')
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({ confirm: 'drej', current: PASSWORD })
    expect(existsSync(path.join(base, 'account.json'))).toBe(false)
    expect(accounts.account()).toBeNull()
  })

  it('carries a provider proof the same way', async () => {
    const { accounts } = signedInMac()
    await accounts.deleteAccount({ stepUp: 'pending-1' }, 'drej')
    expect(JSON.parse(asked.find((a) => a.method === 'DELETE')?.body ?? '{}')).toEqual({ confirm: 'drej', stepUp: 'pending-1' })
  })

  it('keeps the file on a refusal, so this Mac still knows the account', async () => {
    const { base, accounts } = signedInMac()
    answer = { status: 401, body: JSON.stringify({ error: 'bad_credentials', message: 'nope' }) }
    const out = await accounts.deleteAccount('wrong', 'drej')
    expect(out.ok).toBe(false)
    expect(existsSync(path.join(base, 'account.json'))).toBe(true)
    expect(accounts.account()).not.toBeNull()
  })
})

describe('a Mac that missed the delete', () => {
  it('forgets the account once the registry says it is gone, and never on anything less', async () => {
    const { base, accounts } = signedInMac()
    answer = { status: 200, body: JSON.stringify({ username: 'drej' }) }
    expect(await accounts.forgetIfDeleted()).toBe(false)
    expect(existsSync(path.join(base, 'account.json'))).toBe(true)
    answer = { status: 503, body: '{}' }
    expect(await accounts.forgetIfDeleted()).toBe(false)
    expect(existsSync(path.join(base, 'account.json'))).toBe(true)
    answer = { status: 410, body: JSON.stringify({ error: 'account_deleted' }) }
    expect(await accounts.forgetIfDeleted()).toBe(true)
    expect(existsSync(path.join(base, 'account.json'))).toBe(false)
  })
})

describe('the password prompt on a Mac that missed the delete', () => {
  const refused = { status: 401, body: JSON.stringify({ error: 'bad_credentials' }) }

  it('lets the account go instead of refusing the password for ever', async () => {
    const { base, accounts } = signedInMac()
    routes = { 'POST /v2/sessions': refused, 'GET /v2/accounts/drej': { status: 410, body: '{}' } }
    expect(await accounts.resume(PASSWORD)).toMatchObject({ ok: false, reason: 'no_account' })
    expect(existsSync(path.join(base, 'account.json'))).toBe(false)
  })

  it('keeps a real account after a wrong password', async () => {
    const { base, accounts } = signedInMac()
    routes = { 'POST /v2/sessions': refused, 'GET /v2/accounts/drej': { status: 200, body: '{}' } }
    expect((await accounts.resume('wrong')).ok).toBe(false)
    expect(existsSync(path.join(base, 'account.json'))).toBe(true)
  })

  it('ignores a 410 from a registry this account does not belong to', async () => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    writeAccount(fakeAccount({ registry: 'https://elsewhere.example' }), base)
    const accounts = new Accounts({ base, origin })
    answer = { status: 410, body: '{}' }
    expect(await accounts.forgetIfDeleted()).toBe(false)
    expect(existsSync(path.join(base, 'account.json'))).toBe(true)
  })
})

describe('the handlers on a Mac that missed the delete', () => {
  const gone = { status: 410, body: '{}' }
  const refused = { status: 401, body: JSON.stringify({ error: 'bad_credentials' }) }

  const wired = (accounts: Accounts): { handlers: ReturnType<typeof accountHandlers>; left: () => number } => {
    let left = 0
    const deps: AccountIpcDeps = {
      accounts,
      lock: new IdleLock({ lockAfterMs: DEFAULT_LOCK_AFTER_MS, verify: () => false }),
      requests: new Requests({ accounts, notify: () => undefined }),
      factors: new Factors({ accounts, registry: origin }),
      envUsername: null,
      workspaces: () => [],
      saveCodes: () => Promise.resolve({ ok: false, reason: 'no_window' }),
      signedOut: () => void (left += 1)
    }
    return { handlers: accountHandlers(deps), left: () => left }
  }

  it('a refused password winds the Mac down as a sign-out does, doors included', async () => {
    const { base, accounts } = signedInMac()
    routes = { 'POST /v2/sessions': refused, 'GET /v2/accounts/drej': gone }
    const { handlers, left } = wired(accounts)
    const answer = (await handlers['account:resume'](PASSWORD)) as { ok: boolean; value?: { username: unknown } }
    expect(answer.ok).toBe(true)
    expect(answer.value?.username ?? null).toBeNull()
    expect(left()).toBe(1)
    expect(existsSync(path.join(base, 'account.json'))).toBe(false)
  })

  it('an account with no password learns it from the provider button, before any browser opens', async () => {
    const { base, accounts } = signedInMac()
    routes = { 'GET /v2/accounts/drej': gone }
    const { handlers, left } = wired(accounts)
    const answer = (await handlers['account:oauthStart']('github')) as { ok: boolean }
    expect(answer.ok).toBe(true)
    expect(left()).toBe(1)
    expect(existsSync(path.join(base, 'account.json'))).toBe(false)
  })
})

describe('the row in the profile sheet', () => {
  const stub = (): void => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      cookrew: {},
      setTimeout: () => 0,
      clearTimeout: () => undefined
    }
  }

  it('starts as one quiet button', () => {
    stub()
    const html = renderToStaticMarkup(<DeleteAccountRow username="drej" passwordless={false} onStatus={() => undefined} />)
    expect(html).toContain('DELETE ACCOUNT')
    expect(html).not.toContain('type="password"')
  })

  it('opened, names every consequence and what stays, and will not fire on its own', () => {
    stub()
    const html = renderToStaticMarkup(
      <DeleteAccountRow username="drej" passwordless={false} onStatus={() => undefined} initialOpen />
    )
    const text = html.replaceAll('&#x27;', "'").replaceAll('&amp;', '&')
    for (const line of [...DELETE_ACCOUNT_TAKES, ...DELETE_ACCOUNT_KEEPS]) expect(text).toContain(line)
    expect(html).toContain('type="password"')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>DELETE MY ACCOUNT/)
  })

  it('asks no password of an account that has none', () => {
    stub()
    const html = renderToStaticMarkup(<DeleteAccountRow username="drej" passwordless onStatus={() => undefined} initialOpen />)
    expect(html).not.toContain('type="password"')
  })
})
