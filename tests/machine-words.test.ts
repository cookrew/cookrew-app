import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostPlatform, machineCopy, machineTable, machineWord } from '../src/shared/machine-words'

/**
 * THE WORD FOR THE MACHINE IN FRONT OF YOU. The account's sentences were
 * written on a Mac and said "this Mac" on the Solis Linux box. A Mac keeps its
 * own word; everything else gets a true one; a surface that cannot know (the
 * site, a phone) claims nothing and keeps the sentence as written.
 */

describe('the word', () => {
  it('is Mac on a Mac, PC on Windows, machine anywhere else', () => {
    expect(machineWord('darwin')).toBe('Mac')
    expect(machineWord('win32')).toBe('PC')
    expect(machineWord('linux')).toBe('machine')
    expect(machineWord('freebsd')).toBe('machine')
  })
})

describe('a sentence', () => {
  it('stands as written on a Mac, and where the platform is unknown', () => {
    expect(machineCopy('This Mac becomes a device.', 'darwin')).toBe('This Mac becomes a device.')
    expect(machineCopy('This Mac becomes a device.', undefined)).toBe('This Mac becomes a device.')
  })

  it('says machine on Linux in every shape the copy uses', () => {
    expect(machineCopy('This Mac becomes a device.', 'linux')).toBe('This machine becomes a device.')
    expect(machineCopy("On this Mac it keeps this Mac's key.", 'linux')).toBe(
      "On this machine it keeps this machine's key."
    )
    expect(machineCopy('On your phone or other Mac', 'linux')).toBe('On your phone or other machine')
    expect(machineCopy('ADD A MAC', 'linux')).toBe('ADD A MACHINE')
  })

  it('says PC on Windows', () => {
    expect(machineCopy('This Mac leaves @drej.', 'win32')).toBe('This PC leaves @drej.')
    expect(machineCopy('ADD A MAC', 'win32')).toBe('ADD A PC')
  })

  it('leaves a word that merely starts with Mac alone', () => {
    expect(machineCopy('A MacBook is not a Macintosh', 'linux')).toBe('A MacBook is not a Macintosh')
  })
})

describe('a table', () => {
  it('rewrites every sentence and keeps every key', () => {
    const table = { a: 'This Mac', b: 'no machine here' } as const
    expect(machineTable(table, 'linux')).toEqual({ a: 'This machine', b: 'no machine here' })
  })

  it('is the same table where nothing is claimed', () => {
    const table = { a: 'This Mac' } as const
    expect(machineTable(table, undefined)).toBe(table)
    expect(machineTable(table, 'darwin')).toBe(table)
  })
})

describe('the platform this page is drawn on', () => {
  const held = (globalThis as { cookrewPlatform?: unknown }).cookrewPlatform
  afterEach(() => {
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = held
  })

  it('is what the preload published, and nothing on the site or a phone', () => {
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = 'linux'
    expect(hostPlatform()).toBe('linux')
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = undefined
    expect(hostPlatform()).toBeUndefined()
  })

  it('takes nothing that is not a string', () => {
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = { linux: true }
    expect(hostPlatform()).toBeUndefined()
  })
})

describe('the account tables, on a machine that is not a Mac', () => {
  const load = async (platform: string | undefined) => {
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = platform
    vi.resetModules()
    const copy = await import('../src/shared/account-copy')
    const store = await import('../src/renderer/src/account/account-store')
    return { copy, store }
  }
  afterEach(() => {
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = undefined
    vi.resetModules()
  })

  it('says machine in the shared table and in the desktop table, on Linux', async () => {
    const { copy, store } = await load('linux')
    expect(copy.V3_COPY['d9.signin.lede']).toBe('A username and a password. This machine becomes a device on your account.')
    expect(copy.accountCopy('d10.join.lede', { handle: 'drej' })).toContain('this machine joins')
    expect(store.ACCOUNT_COPY.PASSWORD_RULE).toContain('It unlocks Cookrew on this machine')
    expect(JSON.stringify(copy.V3_COPY)).not.toMatch(/\bMac\b/)
    expect(JSON.stringify(store.ACCOUNT_COPY)).not.toMatch(/\bMac\b/)
  })

  it('leaves no Mac in the failure sentences or the refusals', async () => {
    ;(globalThis as { cookrewPlatform?: unknown }).cookrewPlatform = 'linux'
    vi.resetModules()
    const { DOING } = await import('../src/renderer/src/account/problem')
    const { refusalSentence } = await import('../src/renderer/src/account/account-store')
    expect(JSON.stringify(DOING)).not.toMatch(/\bMac\b/)
    expect(refusalSentence('no_account')).toBe('There is no account on this machine yet.')
    expect(refusalSentence('bad_device')).toContain('does not know this machine')
  })

  it('keeps a device name whole when it is filled in on Linux', async () => {
    const { copy } = await load('linux')
    expect(copy.accountCopy('d14.moved', { door: 'alpha', device: 'Mac Studio' })).toBe(
      'alpha moved to Mac Studio. This machine stopped serving it.'
    )
  })

  it('leaves every sentence as written where no platform was published', async () => {
    const { copy, store } = await load(undefined)
    expect(copy.V3_COPY['d9.signin.lede']).toContain('This Mac becomes a device')
    expect(store.ACCOUNT_COPY.PASSWORD_RULE).toContain('on this Mac')
  })
})

describe('the sentences main writes itself', () => {
  it('says machine on Linux, and files no "This Mac" as a device name', async () => {
    const { Accounts, writeAccount, mintDeviceKey, deviceIdFor } = await import('../src/main/account-v2')
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-words-'))
    try {
      const bodies: string[] = []
      const nameless = new Accounts({
        base,
        origin: 'http://127.0.0.1:1',
        platform: 'linux',
        fetch: async (_input, init) => {
          bodies.push(String(init?.body))
          throw new Error('no socket in this test')
        }
      })
      await nameless.signIn({ username: 'drej', password: 'correct-horse-battery' })
      expect(JSON.parse(bodies[0] ?? '{}').device.name).toBe('This machine')

      const keys = mintDeviceKey()
      writeAccount(
        {
          username: 'drej',
          deviceId: deviceIdFor(keys.publicKeyJwk),
          kind: 'desktop',
          name: 'Linux · solis-model-test',
          ...keys,
          registry: 'http://127.0.0.1:1',
          session: null,
          unlock: null,
          lockAfterMs: 0,
          claimedAt: 0,
          workspacesReachable: true,
          recoveryCodesSavedAt: null
        },
        base
      )
      const held = new Accounts({ base, origin: 'http://127.0.0.1:1', platform: 'linux', fetch: async () => new Response() })
      const answer = await held.signIn({ username: 'other', password: 'correct-horse-battery' })
      expect(answer).toMatchObject({ ok: false, reason: 'taken', message: 'This machine is already @drej.' })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
