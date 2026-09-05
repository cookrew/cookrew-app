import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  atomicToUsd,
  openAdmission,
  signInToDoor,
  startStripeCheckout,
  stripePaymentHeader
} from '../src/main/served-admission'

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

describe('atomic USDC → decimal', () => {
  it('is the inverse of the quote builder', () => {
    expect(atomicToUsd('2500000')).toBe('2.5')
    expect(atomicToUsd('1000000')).toBe('1')
    expect(atomicToUsd('1')).toBe('0.000001')
    expect(atomicToUsd('0')).toBe('0')
    expect(atomicToUsd('not-a-number')).toBe('0')
  })
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
