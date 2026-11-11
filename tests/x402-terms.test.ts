import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { railsFromTerms } from '../src/main/served-admission'
import { buildX402Payment, readX402Quote } from '../src/main/x402-caller'
import { BASE_SEPOLIA } from '../src/main/x402-rail'
import {
  X402_MAX_ATOMIC,
  X402_NETWORKS,
  parseX402Terms,
  x402TermsKey,
  x402TermsPrice
} from '../src/shared/x402-terms'

/**
 * ONE READING OF A DOOR'S WALLET TERMS (A, B).
 *
 * The pay step prints an amount and the wallet signs one, and both come from
 * the same string a DOOR wrote. They used to be read by two parsers: the label
 * called anything that was not plain digits "0", and the signer handed it to
 * BigInt, which reads `0x3B9ACA00` as a thousand dollars. "0 USDC" on the
 * sheet, 1000 USDC in the signature.
 *
 * So there is one parser, and both sides use what it returns. A quote it will
 * not read is not offered and cannot be signed; the token is USDC on a network
 * this app knows, by contract address, or it is neither.
 */

const GOOD = {
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '1000000',
  resource: 'https://door.example/alpha',
  description: 'one seat',
  mimeType: 'application/json',
  payTo: '0xc8eE69Bb8da2804B860bE6E4AFa9ACCCDb2053A5',
  maxTimeoutSeconds: 300,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  extra: { name: 'USDC', version: '2' }
}

/** Every way a door might spell an amount that is not the number it looks like. */
const HOSTILE_AMOUNTS: readonly unknown[] = [
  '0x3B9ACA00',
  '0X3B9ACA00',
  ' 1000000000',
  '1000000000 ',
  '+1000000000',
  '-1',
  '0b1111',
  '0o777',
  '1e9',
  '1_000_000',
  '1,000,000',
  '1.5',
  '01000000',
  '0',
  '',
  '١٠٠٠٠٠٠',
  '1'.repeat(40),
  1000000,
  1000000n,
  null,
  undefined,
  ['1000000'],
  { toString: () => '1000000' }
]

const HOSTILE_FIELDS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['a scheme that is not exact', { scheme: 'upto' }],
  ['a network this app does not know', { network: 'ethereum' }],
  ['a network that is a prototype key', { network: 'constructor' }],
  ['a payee that is not an address', { payTo: 'mira.eth' }],
  ['a payee one digit short', { payTo: '0xc8eE69Bb8da2804B860bE6E4AFa9ACCCDb2053A' }],
  ['a payee with a space', { payTo: ' 0xc8eE69Bb8da2804B860bE6E4AFa9ACCCDb2053A5' }],
  ['an asset that is not an address', { asset: 'USDC' }],
  ['ANOTHER TOKEN on the right network', { asset: '0x4200000000000000000000000000000000000006' }],
  ['mainnet USDC quoted on the test network', { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
  ['a validity of zero', { maxTimeoutSeconds: 0 }],
  ['a negative validity', { maxTimeoutSeconds: -300 }],
  ['a fractional validity', { maxTimeoutSeconds: 300.5 }],
  ['a validity of a week', { maxTimeoutSeconds: 7 * 24 * 3600 }],
  ['a validity written as text', { maxTimeoutSeconds: '300' }],
  ['a validity that is not a number', { maxTimeoutSeconds: Number.NaN }],
  ['no signing domain', { extra: undefined }],
  ['a domain name that is not text', { extra: { name: 7, version: '2' } }],
  ['a domain name with a newline', { extra: { name: 'USDC\nextra', version: '2' } }],
  ['a domain name of two hundred letters', { extra: { name: 'U'.repeat(200), version: '2' } }],
  ['an empty domain version', { extra: { name: 'USDC', version: '' } }],
  // The key joins its fields with `|`: a name that contains one could make two different quotes share a key.
  ['a domain name with the key’s own separator', { extra: { name: 'USDC|2', version: '2' } }],
  ['a domain version with the key’s own separator', { extra: { name: 'USDC', version: '2|x' } }],
  // More than a million USDC is not a seat's price: not offered, not signed.
  ['an amount above the ceiling', { maxAmountRequired: '1000000000001' }],
  ['an amount far above the ceiling', { maxAmountRequired: '9'.repeat(30) }]
]

describe('parseX402Terms', () => {
  it('reads a well-formed quote into numbers, not strings to be read again', () => {
    const terms = parseX402Terms(GOOD)
    expect(terms).toEqual({
      network: 'base-sepolia',
      chainId: 84532,
      amount: 1000000n,
      payTo: '0xc8eE69Bb8da2804B860bE6E4AFa9ACCCDb2053A5',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      maxTimeoutSeconds: 300,
      name: 'USDC',
      version: '2'
    })
  })

  it.each(HOSTILE_AMOUNTS.map((amount) => [String(amount), amount] as const))('refuses the amount %j', (_spelling, amount) => {
    expect(parseX402Terms({ ...GOOD, maxAmountRequired: amount })).toBeNull()
  })

  it.each(HOSTILE_FIELDS)('refuses %s', (_what, patch) => {
    expect(parseX402Terms({ ...GOOD, ...patch })).toBeNull()
  })

  it('refuses what is not a quote at all', () => {
    for (const raw of [null, undefined, 'exact', 42, [], [GOOD]]) expect(parseX402Terms(raw)).toBeNull()
  })

  it('the token is USDC by CONTRACT, per network — the label says USDC, so nothing else may be signed', () => {
    expect(Object.keys(X402_NETWORKS).sort()).toEqual(['base', 'base-sepolia'])
    expect(X402_NETWORKS['base-sepolia']).toMatchObject({ chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
    expect(X402_NETWORKS.base).toMatchObject({ chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })
    // What a door on the default network quotes is what this app will pay.
    expect(BASE_SEPOLIA.asset).toBe(X402_NETWORKS['base-sepolia'].usdc)
    // Mainnet USDC on mainnet is read; an address differing only in case is the same contract.
    expect(parseX402Terms({ ...GOOD, network: 'base', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' })).not.toBeNull()
  })
})

describe('the label and the key come from the parsed terms', () => {
  it('prices from the bigint, six decimals, no float anywhere', () => {
    const price = (atomic: string): string => x402TermsPrice(parseX402Terms({ ...GOOD, maxAmountRequired: atomic })!)
    expect(price('1000000')).toBe('1')
    expect(price('2500000')).toBe('2.5')
    expect(price('1')).toBe('0.000001')
    expect(price('1000000000')).toBe('1000')
    // The most a rail is ever offered for: a million USDC, exactly.
    expect(X402_MAX_ATOMIC).toBe(10n ** 12n)
    expect(price('1000000000000')).toBe('1000000')
  })

  it('the key names every signed field, and nothing that is not signed', () => {
    const key = x402TermsKey(parseX402Terms(GOOD)!)
    expect(key).toBe(x402TermsKey(parseX402Terms({ ...GOOD, description: 'reworded', resource: 'elsewhere' })!))
    // An address is the same address in any case.
    expect(key).toBe(x402TermsKey(parseX402Terms({ ...GOOD, payTo: GOOD.payTo.toLowerCase() })!))
    for (const patch of [
      { maxAmountRequired: '1000001' },
      { payTo: '0x000000000000000000000000000000000000dEaD' },
      { maxTimeoutSeconds: 301 },
      { extra: { name: 'USD Coin', version: '2' } },
      { extra: { name: 'USDC', version: '1' } },
      { network: 'base', asset: X402_NETWORKS.base.usdc }
    ]) {
      expect(x402TermsKey(parseX402Terms({ ...GOOD, ...patch })!), JSON.stringify(patch)).not.toBe(key)
    }
  })
})

/**
 * One character of a mixed-case address changed: a different account, and a
 * failed checksum. The shared reader cannot hash, so it is main's one reading
 * (x402-caller.ts readX402Quote) — the label's and the signer's — that refuses it.
 */
const MISTYPED = '0xc8eE69Bb8da2804B860bE6E4AFa9ACCCDb2053B5'

describe('railsFromTerms — a quote the app will not read is not offered', () => {
  const offered = (entry: unknown): unknown[] => railsFromTerms({ x402Version: 1, accepts: [entry] }, null)

  it('a payee with a broken checksum is not offered, and not signed', async () => {
    expect(offered({ ...GOOD, payTo: MISTYPED })).toEqual([])
    expect(readX402Quote({ ...GOOD, payTo: MISTYPED })).toBeNull()
    await expect(buildX402Payment({ ...GOOD, payTo: MISTYPED } as never)).rejects.toThrow(/nothing was signed/)
    // The same account in plain lower case carries no checksum to break.
    expect(offered({ ...GOOD, payTo: GOOD.payTo.toLowerCase() })).toHaveLength(1)
  })

  it('offers a well-formed quote, labelled from the same number it will sign', () => {
    expect(offered(GOOD)).toMatchObject([
      { rail: 'x402', price: '1', asset: 'USDC', chain: 'base-sepolia', payTo: GOOD.payTo, shown: x402TermsKey(parseX402Terms(GOOD)!) }
    ])
  })

  it.each(HOSTILE_AMOUNTS.map((amount) => [String(amount), amount] as const))('no chip for the amount %j', (_spelling, amount) => {
    expect(offered({ ...GOOD, maxAmountRequired: amount })).toEqual([])
  })

  it.each(HOSTILE_FIELDS)('no chip for %s', (_what, patch) => {
    expect(offered({ ...GOOD, ...patch })).toEqual([])
  })

  it('a card beside an unreadable wallet quote is still offered', () => {
    expect(
      railsFromTerms({ x402Version: 1, accepts: [{ ...GOOD, maxAmountRequired: '0x3B9ACA00' }, { scheme: 'stripe-checkout', amountUsd: '1.00' }] }, null)
    ).toMatchObject([{ rail: 'stripe', price: '1.00' }])
  })
})

describe('buildX402Payment — the signer reads with the same parser, or signs nothing', () => {
  /** A wallet nobody owns, in a home nobody uses: a signature is made and never sent anywhere. */
  let home = ''
  const realHome = process.env.HOME
  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'x402-terms-home-'))
    mkdirSync(path.join(home, '.cookrew'), { recursive: true, mode: 0o700 })
    const file = path.join(home, '.cookrew', 'x402-caller.env')
    writeFileSync(file, `X402_CALLER_PRIVATE_KEY=0x${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
    process.env.HOME = home
  })
  afterAll(() => {
    process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  })

  const signedValue = async (raw: unknown): Promise<{ value: string; to: string }> => {
    const header = await buildX402Payment(raw as never)
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      payload: { authorization: { value: string; to: string } }
    }
    return decoded.payload.authorization
  }

  it('the good value: what the label printed is the number in the signature', async () => {
    const terms = parseX402Terms(GOOD)!
    const signed = await signedValue(GOOD)
    expect(signed.value).toBe('1000000')
    expect(BigInt(signed.value)).toBe(terms.amount)
    expect(x402TermsPrice(terms)).toBe('1')
    expect(signed.to).toBe(GOOD.payTo)
  })

  it.each(HOSTILE_AMOUNTS.map((amount) => [String(amount), amount] as const))('throws before signing for the amount %j', async (_spelling, amount) => {
    await expect(buildX402Payment({ ...GOOD, maxAmountRequired: amount } as never)).rejects.toThrow(/nothing was signed/)
  })

  it.each(HOSTILE_FIELDS)('throws before signing for %s', async (_what, patch) => {
    await expect(buildX402Payment({ ...GOOD, ...patch } as never)).rejects.toThrow(/nothing was signed/)
  })
})
