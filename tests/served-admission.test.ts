import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  openAdmission,
  signInToDoor,
  startStripeCheckout,
  stripePaymentHeader
} from '../src/main/served-admission'
import { PrivacyCache } from '../src/main/file-privacy'
import { originTag } from '../resources/caller-keys.mjs'
import { ACE_ALLOWED, ace, acl, descriptor } from './support/security-descriptor'

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'

/**
 * THE CALLER'S SIDE OF THE GATE, over a real socket.
 *
 * What matters here is that every answer a served door can give becomes the
 * right PHASE — the gate sheet is a picture of these, so a mistranslation here
 * is a sheet that lies about money.
 */

interface Door {
  origin: string
  target: { origin: string; slug: string }
  seen: Array<{ path: string; payment?: string }>
  close: () => Promise<void>
}

function door(
  answer: (
    path: string,
    payment?: string,
    requestBody?: unknown
  ) => { status: number; body?: unknown }
): Promise<Door> {
  const seen: Door['seen'] = []
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://x')
        const path = url.pathname.replace('/team', '')
        const payment = request.headers['x-payment']
        seen.push({ path, ...(typeof payment === 'string' ? { payment } : {}) })
        let parsed: unknown = null
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
        const { status, body } = answer(
          path,
          typeof payment === 'string' ? payment : undefined,
          parsed
        )
        // 0: the answer is lost on the way back, as when a connection drops.
        if (status === 0) {
          request.socket.destroy()
          return
        }
        if (status === 200 && path === '/line') {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write(': ok\n\n')
          return
        }
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body ?? {}))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${port}`
      resolve({
        origin,
        target: { origin, slug: 'team' },
        seen,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}

const X402_TERMS = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '2500000',
      resource: '/team/ask',
      description: 'One session',
      mimeType: 'application/json',
      payTo: '0xc8eE69Bb8da2804B860bE6E4AFa9ACCCDb2053A5',
      maxTimeoutSeconds: 300,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USDC', version: '2' }
    },
    { scheme: 'stripe-checkout', network: 'stripe', amountUsd: '2.50', currency: 'usd' }
  ]
}

let open: Door | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

describe('opening admission', () => {
  it('a 200 is an open session, and the stream is not held', async () => {
    open = await door(() => ({ status: 200 }))
    await expect(openAdmission(open.target, 'tok')).resolves.toEqual({ kind: 'open' })
  })

  it('a 402 becomes a pay phase carrying BOTH rails with real terms', async () => {
    open = await door(() => ({ status: 402, body: { terms: X402_TERMS } }))
    const phase = await openAdmission(open.target, 'tok')
    expect(phase.kind).toBe('pay')
    if (phase.kind !== 'pay') return
    expect(phase.rails.map((rail) => rail.rail)).toEqual(['x402', 'stripe'])
    const usdc = phase.rails[0]
    expect(usdc).toMatchObject({ price: '2.5', asset: 'USDC', chain: 'base-sepolia' })
    // The decimal price is derived from the quote, never from a hint.
    expect(phase.rails[1]).toMatchObject({ price: '2.50', asset: 'USD' })
  })

  it('a refused settle accuses; an unverifiable one apologises', async () => {
    open = await door(() => ({ status: 402, body: { reason: 'invalid', retryable: false } }))
    await expect(openAdmission(open.target, 'tok', 'pay')).resolves.toEqual({
      kind: 'denied',
      reason: 'payment_invalid',
      retryable: false
    })
    await open.close()
    open = await door(() => ({ status: 402, body: { reason: 'unverifiable', retryable: true } }))
    await expect(openAdmission(open.target, 'tok', 'pay')).resolves.toEqual({
      kind: 'denied',
      reason: 'payment_unverifiable',
      retryable: true
    })
  })

  it("the owner's budget is its own refusal — not a payment problem", async () => {
    open = await door(() => ({ status: 429, body: { reason: 'budget' } }))
    await expect(openAdmission(open.target, 'tok')).resolves.toEqual({
      kind: 'denied',
      reason: 'budget',
      retryable: false
    })
  })

  it('an unquotable paid door is named, not silently free', async () => {
    open = await door(() => ({ status: 503, body: { reason: 'payment_unavailable' } }))
    await expect(openAdmission(open.target, 'tok')).resolves.toEqual({
      kind: 'denied',
      reason: 'payment_unavailable',
      retryable: true
    })
  })

  it('a door that stopped serving is gone, not an error', async () => {
    open = await door(() => ({ status: 404 }))
    await expect(openAdmission(open.target, 'tok')).resolves.toEqual({ kind: 'gone' })
  })

  it('the payment rides one header, and only when there is one', async () => {
    open = await door(() => ({ status: 200 }))
    await openAdmission(open.target, 'tok')
    await openAdmission(open.target, 'tok', 'PAY-HEADER')
    expect(open.seen.map((entry) => entry.payment)).toEqual([undefined, 'PAY-HEADER'])
  })
})

describe('the card rail', () => {
  it('takes the session id out of the checkout link', async () => {
    open = await door(() => ({
      status: 200,
      body: { url: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fid' }
    }))
    await expect(startStripeCheckout(open.target, 'tok')).resolves.toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fid',
      session: 'cs_test_a1B2c3'
    })
  })

  it('refuses any address that is not Stripe’s hosted Checkout — the door does not choose what the app opens', async () => {
    // The URL is the DOOR's word, and the app goes on to open it in the real
    // browser. A scheme the OS will launch, a look-alike host, a fragment that
    // smuggles the session id past a regex: all of them end here, unopened.
    for (const url of [
      'file:///Applications/Calculator.app#/cs_x',
      'smb://evil.example/share/cs_test_1',
      'javascript:alert(1)//cs_test_1',
      'http://checkout.stripe.com/c/pay/cs_test_1',
      'https://checkout.stripe.com.evil.example/c/pay/cs_test_1',
      'https://evil.example/#https://checkout.stripe.com/cs_x',
      'https://checkout.stripe.com@evil.example/cs_x',
      'https://user:pw@checkout.stripe.com/c/pay/cs_test_1',
      42
    ]) {
      open = await door(() => ({ status: 200, body: { url } }))
      await expect(startStripeCheckout(open.target, 'tok'), String(url)).rejects.toThrow(/unusable checkout link/)
      await open.close()
    }
    open = null
  })

  it('reads the session from the PATH, never from a fragment or a query', async () => {
    open = await door(() => ({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay#/cs_test_smuggled' } }))
    await expect(startStripeCheckout(open.target, 'tok')).rejects.toThrow(/unusable/)
    await open.close()
    open = await door(() => ({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay?x=/cs_test_smuggled' } }))
    await expect(startStripeCheckout(open.target, 'tok')).rejects.toThrow(/unusable/)
  })

  it('refuses a link with no session in it rather than guessing', async () => {
    open = await door(() => ({ status: 200, body: { url: 'https://checkout.stripe.com/' } }))
    await expect(startStripeCheckout(open.target, 'tok')).rejects.toThrow(/unusable/)
  })

  it('says card payment is unavailable when the door has no key', async () => {
    open = await door(() => ({ status: 503, body: {} }))
    await expect(startStripeCheckout(open.target, 'tok')).rejects.toThrow(/not available/)
  })

  it('presents a settled session in the shape the rail decodes', () => {
    const header = stripePaymentHeader('cs_test_9')
    expect(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))).toEqual({
      rail: 'stripe',
      session: 'cs_test_9'
    })
  })
})

describe('one account, however you reach the door', () => {
  /**
   * THE LOCKOUT THIS PINS.
   *
   * A door binds an account to (serviceId, sub) and TOFU refuses a second key
   * for a known name — that is the whole point of TOFU. The caller's key used
   * to be filed by network ADDRESS, so reaching the same team by loopback
   * instead of its LAN address minted a DIFFERENT key for the same name and
   * the door refused it forever. Observed live: a placed card died with
   * "sign-in refused" and left a frozen terminal on the canvas.
   */
  it('signs in with a key filed under an old address, and promotes it', async () => {
    const enrolled: Array<Record<string, unknown>> = []
    let known: string | null = null
    open = await door((path, _payment, body) => {
      if (path === '/crew') return { status: 200, body: { serviceId: 'svc-team' } }
      if (path === '/api/call/challenge') return { status: 200, body: { challenge: 'nonce' } }
      if (path === '/api/call/assert') {
        const jwk = JSON.stringify((body as { jwk?: unknown })?.jwk ?? null)
        // TOFU: first key wins the name; any other key is refused.
        if (known === null) known = jwk
        if (jwk !== known) return { status: 401, body: {} }
        enrolled.push({ jwk })
        return { status: 200, body: { token: 'tok' } }
      }
      return { status: 404 }
    })

    const dir = mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
    // Pretend this device already holds a key under the OLD address-shaped
    // name, and that it is the key the door knows.
    const legacy = path.join(dir, 'legacy.json')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(
      legacy,
      JSON.stringify({ pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) }),
      { mode: 0o600 }
    )
    known = JSON.stringify(publicKey.export({ format: 'jwk' }))

    const canonical = path.join(dir, 'svc-team.json')
    const token = await signInToDoor(open.target, {
      sub: 'ana',
      candidates: () => [canonical, legacy],
      canonical: () => canonical
    })
    expect(token).toBe('tok')
    // The winning key now lives under the door's identity, so the address
    // file is never needed again.
    expect(existsSync(canonical)).toBe(true)
    expect(JSON.parse(readFileSync(canonical, 'utf8')).pub).toEqual(
      publicKey.export({ format: 'jwk' })
    )
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('a new account’s key is kept BEFORE the door binds it (a bound key that is lost is a lost account)', () => {
  type Verdict = 'bind' | 'refuse' | 'lose' | 'busy'
  /**
   * A TOFU door: the first key to assert a name owns it. Per attempt it may
   * bind (or accept the bound key), REFUSE (401), LOSE the answer after
   * binding, or be BUSY (503, binding nothing).
   */
  const tofuDoor = async (answerAssert: (attempt: number) => Verdict = () => 'bind') => {
    const asserts: Array<{ pendingOnDisk: number; jwk: string }> = []
    let bound: string | null = null
    let dir = ''
    const pendings = (): string[] => readdirSync(dir).filter((name) => name.startsWith('svc-team.json.pending-'))
    const opened = await door((path, _payment, body) => {
      if (path === '/crew') return { status: 200, body: { serviceId: 'svc-team' } }
      if (path === '/api/call/challenge') return { status: 200, body: { challenge: 'nonce' } }
      if (path === '/api/call/assert') {
        const jwk = JSON.stringify((body as { jwk?: unknown })?.jwk ?? null)
        asserts.push({ pendingOnDisk: pendings().length, jwk })
        const verdict = answerAssert(asserts.length)
        if (verdict === 'refuse') return { status: 401, body: {} }
        if (verdict === 'busy') return { status: 503, body: {} }
        bound ??= jwk
        if (jwk !== bound) return { status: 401, body: {} }
        return verdict === 'lose' ? { status: 0 } : { status: 200, body: { token: 'tok' } }
      }
      return { status: 404 }
    })
    dir = mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
    const canonical = path.join(dir, 'svc-team.json')
    const store = { sub: 'ana', candidates: () => [canonical], canonical: () => canonical }
    const filed = (): string | null => (existsSync(canonical) ? JSON.stringify(JSON.parse(readFileSync(canonical, 'utf8')).pub) : null)
    return { opened, dir, canonical, store, asserts, pendings, filed, bound: () => bound }
  }

  it('is written and proven private before the first assert, then filed under the door', async () => {
    const rig = await tofuDoor()
    open = rig.opened
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    expect(rig.asserts.map((a) => a.pendingOnDisk)).toEqual([1])
    expect(rig.filed()).toBe(rig.bound())
    expect(rig.pendings()).toEqual([])
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('a refused new key is KEPT, and offered again rather than replaced: one key per door, ever', async () => {
    const rig = await tofuDoor(() => 'refuse')
    open = rig.opened
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow(/already belongs to another key/)
    expect(rig.pendings()).toHaveLength(1)
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow(/refused/)
    expect(rig.pendings()).toHaveLength(1)
    expect(new Set(rig.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(existsSync(rig.canonical)).toBe(false)
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('a door that is busy (5xx) has refused nothing: the key stays, and is the one used next time', async () => {
    const rig = await tofuDoor((attempt) => (attempt === 1 ? 'busy' : 'bind'))
    open = rig.opened
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow(/503/)
    expect(rig.pendings()).toHaveLength(1)
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    // The same key both times: nothing was minted over it.
    expect(new Set(rig.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(rig.filed()).toBe(rig.bound())
    expect(rig.pendings()).toEqual([])
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('a kept key that meets a busy door is NOT replaced by a fresh one', async () => {
    const rig = await tofuDoor((attempt) => (attempt === 1 ? 'lose' : attempt === 2 ? 'busy' : 'bind'))
    open = rig.opened
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow()
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow(/503/)
    expect(rig.pendings()).toHaveLength(1)
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    expect(new Set(rig.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(rig.filed()).toBe(rig.bound())
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('never reaches the door when it cannot be proven private: nothing is bound, nothing is kept', async () => {
    const rig = await tofuDoor()
    open = rig.opened
    const OPEN_LIST = descriptor({ owner: SID, dacl: acl([ace(ACE_ALLOWED, SID), ace(ACE_ALLOWED, 'S-1-1-0')]) })
    const privacy = {
      platform: 'win32' as const,
      cache: new PrivacyCache(),
      windows: {
        readFolder: async () => ({ userSid: SID, descriptor: descriptor({ owner: SID, dacl: acl([ace(ACE_ALLOWED, SID)]) }) }),
        createPrivate: async (file: string, data: Buffer) => {
          writeFileSync(file, data, { flag: 'wx' })
          return { userSid: SID, descriptor: OPEN_LIST }
        },
        read: async () => ({ userSid: SID, descriptor: OPEN_LIST })
      }
    }
    await expect(signInToDoor(rig.opened.target, { ...rig.store, privacy })).rejects.toThrow(/was not written/)
    expect(rig.asserts).toEqual([])
    // No key, and nothing else but this device's tag secret (caller-keys.mjs).
    expect(readdirSync(rig.dir)).toEqual(['.origin-key'])
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('is KEPT when the answer is lost (the door may have bound it), and opens the account next time', async () => {
    const rig = await tofuDoor((attempt) => (attempt === 1 ? 'lose' : 'bind'))
    open = rig.opened
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow()
    expect(rig.pendings()).toHaveLength(1)
    // The door bound that key; a fresh mint would be refused. The kept one is tried, and filed.
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    expect(rig.filed()).toBe(rig.bound())
    expect(rig.pendings()).toEqual([])
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('offers EVERY kept key: the one the door binds is filed, and the others are set aside, never deleted', async () => {
    const rig = await tofuDoor()
    open = rig.opened
    const tag = originTag(new URL(rig.opened.target.origin).origin, rig.dir)
    const keep = (suffix: string): string => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const raw = JSON.stringify({ pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) })
      writeFileSync(path.join(rig.dir, `svc-team.json.pending-${tag}-${suffix}`), raw, { mode: 0o600 })
      return JSON.stringify(publicKey.export({ format: 'jwk' }))
    }
    const first = keep('aaaaaaaaaaaa')
    const second = keep('bbbbbbbbbbbb')
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    // Whichever the door met first owns the name and is filed; the other is set aside in retired/.
    expect([first, second]).toContain(rig.bound())
    expect(rig.filed()).toBe(rig.bound())
    expect(rig.pendings()).toEqual([])
    expect(readdirSync(path.join(rig.dir, 'retired'))).toHaveLength(1)
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('a kept key the door may hold survives a forced 401 (a 401 is any failure, not "someone else’s")', async () => {
    const rig = await tofuDoor((attempt) => (attempt === 1 ? 'lose' : attempt === 2 ? 'refuse' : 'bind'))
    open = rig.opened
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow()
    // The kept key meets a forced 401: refused, kept, and no fresh key is made over it.
    await expect(signInToDoor(rig.opened.target, rig.store)).rejects.toThrow(/refused/)
    expect(rig.pendings()).toHaveLength(1)
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    expect(new Set(rig.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(rig.filed()).toBe(rig.bound())
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('(c) a door that answers the filed key 401 and binds a new one leaves the filed key untouched, and keeps both', async () => {
    // A door claiming another door's serviceId: the filed key of the real account is refused, a fresh one taken.
    const rig = await tofuDoor((attempt) => (attempt === 1 ? 'refuse' : 'bind'))
    open = rig.opened
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const mine = JSON.stringify({ pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) })
    writeFileSync(rig.canonical, mine, { mode: 0o600 })
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    expect(readFileSync(rig.canonical, 'utf8')).toBe(mine)
    expect(rig.pendings()).toHaveLength(1)
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('another door’s key whose name merely starts like a kept key is never offered here, or removed', async () => {
    const rig = await tofuDoor()
    open = rig.opened
    // The canonical key of a door whose serviceId is `svc-team.json.pending-y`.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const theirs = path.join(rig.dir, 'svc-team.json.pending-y.json')
    writeFileSync(theirs, JSON.stringify({ pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) }), { mode: 0o600 })
    expect(await signInToDoor(rig.opened.target, rig.store)).toBe('tok')
    expect(rig.asserts.map((a) => a.jwk)).not.toContain(JSON.stringify(publicKey.export({ format: 'jwk' })))
    expect(existsSync(theirs)).toBe(true)
    rmSync(rig.dir, { recursive: true, force: true })
  })

  it('two sign-ins at once to one door bind ONE key, and that is the key filed', async () => {
    const rig = await tofuDoor()
    open = rig.opened
    // Each minted key is held until a second one is being made too (or 200 ms
    // pass): without one sign-in per door at a time, both reach the door
    // together, one is bound, and the other sign-in is refused.
    let minting = 0
    const PRIVATE_LIST = descriptor({ owner: SID, dacl: acl([ace(ACE_ALLOWED, SID)]), protectedDacl: true })
    const privacy = {
      platform: 'win32' as const,
      cache: new PrivacyCache(),
      windows: {
        readFolder: async () => ({ userSid: SID, descriptor: PRIVATE_LIST }),
        read: async () => ({ userSid: SID, descriptor: PRIVATE_LIST }),
        createPrivate: async (file: string, data: Buffer) => {
          minting += 1
          for (let waited = 0; minting < 2 && waited < 200; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
          writeFileSync(file, data, { flag: 'wx' })
          return { userSid: SID, descriptor: PRIVATE_LIST }
        }
      }
    }
    const store = { ...rig.store, privacy }
    const both = await Promise.all([signInToDoor(rig.opened.target, store), signInToDoor(rig.opened.target, store)])
    expect(minting).toBe(1)
    expect(both).toEqual(['tok', 'tok'])
    expect(new Set(rig.asserts.map((a) => a.jwk)).size).toBe(1)
    expect(rig.filed()).toBe(rig.bound())
    expect(rig.pendings()).toEqual([])
    rmSync(rig.dir, { recursive: true, force: true })
  })
})
