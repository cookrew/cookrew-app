// A REAL CHROME, A SESSION COOKIE, A RESTART (owner 11-28). Chrome drops a
// session cookie at every start by design; the card's vault brings it back.
// Run with COOKREW_REAL_CHROME_TEST=1.
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChrome, HeadlessInstance, type HeadlessOptions } from '../src/main/headless-chrome'
import { createCardCookieVault } from '../src/main/card-cookie-vault'
import type { SafeStorageLike } from '../src/main/secrets-seal'

const chrome = findChrome()
const enabled = process.env.COOKREW_REAL_CHROME_TEST === '1' && chrome !== null

const reversible: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
  decryptString: (box) => Buffer.from(box).reverse().toString('utf8')
}

describe.skipIf(!enabled)('card cookie vault, real Chromium', () => {
  let server: http.Server
  let origin = ''
  let root = ''

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>login</title><h1>login</h1>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    origin = `http://127.0.0.1:${address.port}`
    root = mkdtempSync(path.join(tmpdir(), 'cookrew-cookie-vault-'))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  const optionsFor = (card: string, over: Partial<HeadlessOptions> = {}): HeadlessOptions => ({
    executablePath: chrome as string,
    profileDir: path.join(root, card),
    width: 720,
    height: 560,
    tabs: [{ id: 'tab-a', url: `${origin}/login`, title: '' }],
    activeTabId: 'tab-a',
    ...over
  })

  async function signIn(card: string): Promise<HeadlessInstance> {
    mkdirSync(path.join(root, card), { recursive: true })
    const first = new HeadlessInstance(optionsFor(card))
    await first.start()
    await first.evaluate(`document.cookie = 'session-login=yes; path=/'`)
    await first.evaluate(`document.cookie = 'lasting=yes; path=/; Max-Age=3600'`)
    return first
  }

  async function cookieAfterRestart(card: string, over: Partial<HeadlessOptions>): Promise<string> {
    const second = new HeadlessInstance(optionsFor(card, over))
    try {
      await second.start()
      return String(await second.evaluate('document.cookie'))
    } finally {
      await second.stop()
    }
  }

  it('without the vault, Chrome drops the session cookie and keeps the lasting one', async () => {
    const first = await signIn('plain')
    expect((await first.stop()).forced).toBe(false)
    const cookie = await cookieAfterRestart('plain', {})
    expect(cookie).toContain('lasting=yes')
    expect(cookie).not.toContain('session-login=yes')
  }, 30_000)

  it('with the vault, the session cookie is back before the first page script runs', async () => {
    const vault = createCardCookieVault({ safeStorage: reversible, profileRoot: () => root, log: () => undefined })
    const first = await signIn('vaulted')
    expect(vault.save('vaulted', await first.getCookies())).toEqual({ saved: 2 })
    expect((await first.stop()).forced).toBe(false)
    const kept = vault.load('vaulted') ?? []
    expect(kept.map((c) => c.name).sort()).toEqual(['lasting', 'session-login'])
    const cookie = await cookieAfterRestart('vaulted', { restoredCookies: kept })
    expect(cookie).toContain('session-login=yes')
    expect(cookie).toContain('lasting=yes')
  }, 30_000)
})
