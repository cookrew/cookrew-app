// THE ACCOUNT'S IPC IS OWNER-ONLY, and "owner-only" has to mean the owner
// window's TOP FRAME — not "it is IPC, so nobody else can reach it".
//
// The app renders pages it did not author: browser cards host whatever the
// owner browsed to, an install page comes from a registry, a preset can ship a
// URL. Any of those reaching account:claim or account:recoveryCodes would be
// the listener hole in different clothes. So two things are checked here:
//
//   EVERY channel refuses a sender that is not the owner window's top frame.
//   THE CALL SITE in main registers them through the wrapper, not one by one.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isOwnerSender } from '../src/main/owner-grant'
import {
  ACCOUNT_CHANNELS,
  accountHandlers,
  accountStatus,
  registerAccountIpc,
  type AccountHandler,
  type AccountIpcDeps,
} from '../src/main/account-ipc'
import { IdleLock } from '../src/main/lock'
import { Accounts, DEFAULT_LOCK_AFTER_MS } from '../src/main/account-v2'

const OWNER = { id: 'owner-webcontents' }
const TOP = { parent: null }

/** No file, no socket: a local-only desktop, which is a supported state (P4). */
function deps(over: Partial<AccountIpcDeps> = {}): AccountIpcDeps {
  const accounts = new Accounts({
    base: path.join('/nonexistent-cookrew-test', String(Math.random())),
    origin: 'https://registry.test',
    fetch: () => Promise.reject(new Error('no network in this test')),
  })
  return {
    accounts,
    lock: new IdleLock({ lockAfterMs: DEFAULT_LOCK_AFTER_MS, verify: () => false }),
    envUsername: null,
    workspaces: () => [],
    ...over,
  }
}

/** The wrapper main applies — restated here so the refusal is exercised. */
const ownerOnly =
  (op: AccountHandler) =>
  (event: { sender: unknown; senderFrame: { parent: unknown } | null }, ...args: unknown[]) => {
    if (!isOwnerSender(event.sender, event.senderFrame, OWNER)) {
      return { ok: false, reason: 'not_owner' }
    }
    return op(...args)
  }

describe('every account channel is registered, once, through the owner guard', () => {
  it('registers exactly the named set', () => {
    const seen: string[] = []
    registerAccountIpc((channel) => void seen.push(channel), deps())
    expect(seen).toEqual([...ACCOUNT_CHANNELS])
    expect(new Set(seen).size).toBe(ACCOUNT_CHANNELS.length)
  })

  it('REFUSES a browser card and an iframe on every one of them', () => {
    const handlers = accountHandlers(deps())
    for (const channel of ACCOUNT_CHANNELS) {
      const guarded = ownerOnly(handlers[channel])
      expect(guarded({ sender: { id: 'browser-card' }, senderFrame: TOP }, 'x')).toEqual({
        ok: false,
        reason: 'not_owner',
      })
      expect(guarded({ sender: OWNER, senderFrame: { parent: { id: 'top' } } }, 'x')).toEqual({
        ok: false,
        reason: 'not_owner',
      })
      expect(guarded({ sender: OWNER, senderFrame: null }, 'x')).toEqual({
        ok: false,
        reason: 'not_owner',
      })
    }
  })

  it('main wires the account IPC through ownerOnly, not channel by channel', () => {
    // The one place a thirteenth channel could be added unguarded is the call
    // site. It takes a `register`, so the wrapper is applied by construction —
    // this asserts the call site still passes one that applies it.
    const source = readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const call = /registerAccountIpc\(([\s\S]{0,220})/.exec(source)
    expect(call, 'index.ts must register the account IPC').not.toBeNull()
    expect(call?.[1]).toContain('ownerOnly')
    // And no account channel is handled anywhere else in main.
    expect(source).not.toMatch(/ipcMain\.(handle|on)\(\s*'account:/)
  })
})

describe('the status the owner window is given', () => {
  it('says NO ACCOUNT on a local-only desktop, and says it without an error', () => {
    const status = accountStatus(deps())
    expect(status.username).toBeNull()
    expect(status.locked).toBe(false)
    expect(status.lockAfterMs).toBe(DEFAULT_LOCK_AFTER_MS)
    expect(status.sessionExpired).toBe(false)
    expect(status.requests).toBe(0)
  })

  it('reports the env handle so a surface can say the two names differ', () => {
    expect(accountStatus(deps({ envUsername: 'drej' })).envUsername).toBe('drej')
  })

  it('NEVER carries key material or a token across the bridge', () => {
    const status = accountStatus(deps())
    const keys = Object.keys(status)
    expect(keys).not.toContain('privateKeyJwk')
    expect(keys).not.toContain('session')
    expect(keys).not.toContain('unlock')
  })
})

describe('the handlers', () => {
  it('lock() locks and the status says so', async () => {
    const shared = deps()
    const handlers = accountHandlers(shared)
    expect((await handlers['account:lock']()) as { locked: boolean }).toMatchObject({
      locked: true,
    })
  })

  it('setLock writes the setting to BOTH the file and the live timer', () => {
    const shared = deps()
    const setting = vi.spyOn(shared.accounts, 'setLockAfterMs')
    accountHandlers(shared)['account:setLock'](0)
    expect(setting).toHaveBeenCalledWith(0)
    expect(shared.lock.lockAfterMs).toBe(0)
  })

  it('check answers "invalid" for a name the rules refuse, with no network', async () => {
    expect(await accountHandlers(deps())['account:check']('Drej Smith')).toBe('invalid')
  })

  it('claim refuses a weak password before any socket, and never returns a key', async () => {
    const result = (await accountHandlers(deps())['account:claim']({
      username: 'drej',
      password: 'short',
    })) as { ok: boolean; reason: string }
    expect(result).toMatchObject({ ok: false, reason: 'weak_password' })
    expect(JSON.stringify(result)).not.toContain('privateKeyJwk')
  })

  it('coerces junk arguments instead of throwing at the bridge', async () => {
    const handlers = accountHandlers(deps())
    await expect(handlers['account:check'](undefined)).resolves.toBe('invalid')
    await expect(handlers['account:claim'](null)).resolves.toMatchObject({ ok: false })
    expect(() => handlers['account:workspacesReachable']('yes please')).not.toThrow()
  })
})
