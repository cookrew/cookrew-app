// The paid door takes real money, and refuses everything else in the right voice.
//
// What this replaces: devSettle admitted any string starting 'tx-'. The test
// that mattered was therefore never written, because there was nothing to test
// — a prefix cannot be wrong. These are the questions a real rail has to answer.
//
// The facilitator is INJECTED (deps.post), so every branch runs offline and
// deterministically. That is the seam doing its job: the rail is real in
// production and substitutable here, without the gate learning either fact.

import { describe, expect, it } from 'vitest'
import {
  createNonceLedger,
  decodePaymentHeader,
  paymentRequirements,
  usdToAtomic,
  x402Settle,
  BASE_SEPOLIA,
  type PaymentRequirements,
  type X402Config
} from '../src/main/x402-rail'

const CONFIG: X402Config = { ...BASE_SEPOLIA, payTo: '0x1111111111111111111111111111111111111111' }

const REQUIREMENTS: PaymentRequirements = paymentRequirements(CONFIG, '0.50', '/r', 'd')!.accepts[0]

const payload = (over: Record<string, unknown> = {}, auth: Record<string, unknown> = {}): string => {
  const body = {
    x402Version: 1,
    scheme: 'exact',
    network: BASE_SEPOLIA.network,
    payload: {
      signature: '0xsig',
      authorization: {
        from: '0x2222222222222222222222222222222222222222',
        to: CONFIG.payTo,
        value: '500000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: '0xnonce-1',
        ...auth
      }
    },
    ...over
  }
  return Buffer.from(JSON.stringify(body)).toString('base64')
}

/** A facilitator that answers however the test needs, and counts the asking. */
const facilitator = (
  verify: unknown,
  settle: unknown,
  opts: { throwOn?: 'verify' | 'settle'; okVerify?: boolean; okSettle?: boolean } = {}
): { post: X402Deps['post']; calls: string[] } => {
  const calls: string[] = []
  const post = async (url: string): Promise<{ ok: boolean; json: unknown }> => {
    const which = url.endsWith('/verify') ? 'verify' : 'settle'
    calls.push(which)
    if (opts.throwOn === which) throw new Error('network')
    if (which === 'verify') return { ok: opts.okVerify ?? true, json: verify }
    return { ok: opts.okSettle ?? true, json: settle }
  }
  return { post, calls }
}
type X402Deps = Parameters<typeof x402Settle>[0]

const run = (
  header: string,
  f: { post: X402Deps['post'] },
  seen = createNonceLedger()
): Promise<'ok' | 'refused' | 'unverifiable'> =>
  x402Settle({ config: CONFIG, post: f.post, seen }, header, REQUIREMENTS)

describe('usdToAtomic — a price is text, never a float', () => {
  it('converts whole and fractional dollars to 6-decimal atomic units', () => {
    expect(usdToAtomic('1')).toBe('1000000')
    expect(usdToAtomic('0.50')).toBe('500000')
    expect(usdToAtomic('0.000001')).toBe('1')
    expect(usdToAtomic('12.345678')).toBe('12345678')
  })

  it('refuses more precision than USDC has, rather than rounding money', () => {
    // Silently dropping a digit is a charge the caller did not agree to.
    expect(usdToAtomic('0.0000001')).toBeNull()
  })

  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', 'free', '-1', '1e3', '1.2.3', '$1', ' 1 2 ']) {
      expect(usdToAtomic(bad)).toBeNull()
    }
  })
})

describe('the quote', () => {
  it('states real terms — network, asset contract, atomic amount', () => {
    const quote = paymentRequirements(CONFIG, '0.50', '/svc/ask', 'One session')
    expect(quote?.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '500000',
      asset: BASE_SEPOLIA.asset,
      payTo: CONFIG.payTo
    })
  })

  it('REFUSES to quote with no destination configured', () => {
    // Otherwise a caller signs an authorization to nobody and we then have to
    // refuse money they really sent.
    expect(paymentRequirements({ ...CONFIG, payTo: '' }, '0.50', '/r', 'd')).toBeNull()
    expect(paymentRequirements({ ...CONFIG, payTo: '   ' }, '0.50', '/r', 'd')).toBeNull()
  })

  it('refuses to quote an unpriceable or free-but-paid crew', () => {
    expect(paymentRequirements(CONFIG, '', '/r', 'd')).toBeNull()
    expect(paymentRequirements(CONFIG, '0', '/r', 'd')).toBeNull()
  })
})

describe('decodePaymentHeader — nothing from the caller is trusted', () => {
  it('decodes a well-formed payload', () => {
    expect(decodePaymentHeader(payload())?.payload.authorization.nonce).toBe('0xnonce-1')
  })

  it('returns null for junk, empty, and non-object bodies', () => {
    expect(decodePaymentHeader('not base64 at all!!')).toBeNull()
    expect(decodePaymentHeader('')).toBeNull()
    expect(decodePaymentHeader(Buffer.from('"a string"').toString('base64'))).toBeNull()
    expect(decodePaymentHeader(Buffer.from('null').toString('base64'))).toBeNull()
  })

  it('returns null when an authorization field is missing or not a string', () => {
    // A missing nonce that reached the replay ledger would compare equal to the
    // next missing nonce — admitting a replay or refusing an honest payment.
    const noNonce = Buffer.from(
      JSON.stringify({
        scheme: 'exact',
        network: 'base-sepolia',
        payload: { signature: '0xs', authorization: { from: '0xa', to: '0xb', value: '1', validAfter: '0', validBefore: '9' } }
      })
    ).toString('base64')
    expect(decodePaymentHeader(noNonce)).toBeNull()
    expect(decodePaymentHeader(payload({}, { nonce: 123 }))).toBeNull()
  })
})

describe('a bogus payment is REFUSED, and never reaches the facilitator', () => {
  it('refuses an unreadable header without asking anyone', async () => {
    const f = facilitator({ isValid: true }, { success: true })
    expect(await run('garbage', f)).toBe('refused')
    expect(f.calls).toEqual([])
  })

  it('refuses the OLD dev stub strings — the prefix era is over', async () => {
    // The regression this milestone exists to prevent.
    const f = facilitator({ isValid: true }, { success: true })
    for (const stub of ['tx-ok', 'tx-anything', 'bad-x', 'iffy-x']) {
      expect(await run(stub, f)).toBe('refused')
    }
    expect(f.calls).toEqual([])
  })

  it('refuses a payment addressed to somebody else', async () => {
    const f = facilitator({ isValid: true }, { success: true })
    expect(await run(payload({}, { to: '0x9999999999999999999999999999999999999999' }), f)).toBe('refused')
    expect(f.calls).toEqual([])
  })

  it('refuses a payment on the wrong network or scheme', async () => {
    const f = facilitator({ isValid: true }, { success: true })
    expect(await run(payload({ network: 'ethereum' }), f)).toBe('refused')
    expect(await run(payload({ scheme: 'upto' }), f)).toBe('refused')
    expect(f.calls).toEqual([])
  })

  it('refuses when the facilitator LOOKED and said invalid', async () => {
    // The accusing voice, and the only place it is earned by an outside verdict.
    const f = facilitator({ isValid: false, invalidReason: 'insufficient_funds' }, { success: true })
    expect(await run(payload(), f)).toBe('refused')
    expect(f.calls).toEqual(['verify'])
  })
})

describe('what WE could not check APOLOGISES', () => {
  it('is unverifiable when the facilitator is unreachable', async () => {
    const f = facilitator(null, null, { throwOn: 'verify' })
    expect(await run(payload(), f)).toBe('unverifiable')
  })

  it('is unverifiable on a non-2xx or unreadable verify reply', async () => {
    expect(await run(payload(), facilitator({ isValid: true }, {}, { okVerify: false }))).toBe('unverifiable')
    expect(await run(payload(), facilitator({ nonsense: 1 }, {}))).toBe('unverifiable')
    expect(await run(payload(), facilitator(null, {}))).toBe('unverifiable')
  })

  it('is unverifiable when settle fails AFTER a good verify', async () => {
    // Verified but not settled: no money moved, and that is not the caller's
    // fault. Accusing them here would be blaming them for our failed transfer.
    const f = facilitator({ isValid: true }, { success: false, errorReason: 'nonce_used' })
    expect(await run(payload(), f)).toBe('unverifiable')
    expect(f.calls).toEqual(['verify', 'settle'])
  })

  it('is unverifiable when settle throws or answers unreadably', async () => {
    expect(await run(payload(), facilitator({ isValid: true }, null, { throwOn: 'settle' }))).toBe('unverifiable')
    expect(await run(payload(), facilitator({ isValid: true }, { nope: 1 }))).toBe('unverifiable')
  })
})

describe('only a SETTLED payment is ok', () => {
  it('returns ok after verify and settle both succeed', async () => {
    const f = facilitator({ isValid: true }, { success: true, transaction: '0xabc' })
    expect(await run(payload(), f)).toBe('ok')
    expect(f.calls).toEqual(['verify', 'settle'])
  })

  it('never settles a payload that failed verify', async () => {
    const f = facilitator({ isValid: false }, { success: true })
    await run(payload(), f)
    expect(f.calls).not.toContain('settle')
  })
})

describe('replay', () => {
  it('refuses a nonce that already settled', async () => {
    const seen = createNonceLedger()
    const f = facilitator({ isValid: true }, { success: true })
    expect(await run(payload(), f, seen)).toBe('ok')
    expect(await run(payload(), f, seen)).toBe('refused')
    // The replay costs no round trip.
    expect(f.calls).toEqual(['verify', 'settle'])
  })

  it('does NOT burn the nonce when settlement failed', async () => {
    // Burning early would strand a caller whose money never moved: their retry
    // would be refused as a replay of a payment that never happened.
    const seen = createNonceLedger()
    const failing = facilitator({ isValid: true }, { success: false })
    expect(await run(payload(), failing, seen)).toBe('unverifiable')

    const working = facilitator({ isValid: true }, { success: true })
    expect(await run(payload(), working, seen)).toBe('ok')
  })

  it('does not burn the nonce when we could not reach the facilitator', async () => {
    const seen = createNonceLedger()
    expect(await run(payload(), facilitator(null, null, { throwOn: 'verify' }), seen)).toBe('unverifiable')
    expect(await run(payload(), facilitator({ isValid: true }, { success: true }), seen)).toBe('ok')
  })
})

describe('the facilitator is asked about OUR terms, not the caller\'s', () => {
  it('sends the requirements we quoted, so a cent cannot buy a dollar quote', async () => {
    let sent: { paymentRequirements?: PaymentRequirements } = {}
    const post = async (_url: string, body: unknown): Promise<{ ok: boolean; json: unknown }> => {
      sent = body as { paymentRequirements?: PaymentRequirements }
      return { ok: true, json: { isValid: true, success: true } }
    }
    await x402Settle({ config: CONFIG, post, seen: createNonceLedger() }, payload({}, { value: '1' }), REQUIREMENTS)

    expect(sent.paymentRequirements?.maxAmountRequired).toBe('500000')
    expect(sent.paymentRequirements?.payTo).toBe(CONFIG.payTo)
  })
})
