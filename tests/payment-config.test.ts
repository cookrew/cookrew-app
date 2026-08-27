import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createServedPaymentConfig,
  paymentConfigPath
} from '../src/main/served-payment-config'
import { servedPaymentRails } from '../src/shared/served-payment-rails'

const roots: string[] = []
const ADDRESS = '0x1111111111111111111111111111111111111111'
const OVERRIDE = '0x2222222222222222222222222222222222222222'
const FAKE_STRIPE = `sk_test_${'0'.repeat(24)}`

function root(): string {
  const base = path.join(tmpdir(), `cookrew-payment-config-${process.pid}-${roots.length}`)
  roots.push(base)
  mkdirSync(base, { recursive: true })
  return base
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

describe('served payment configuration', () => {
  it('persists the public USDC address atomically in payment.json', () => {
    const base = root()
    const config = createServedPaymentConfig({ base, env: {} })

    expect(config.setPayTo(ADDRESS)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(paymentConfigPath(base), 'utf8'))).toEqual({ payTo: ADDRESS })
    expect(existsSync(`${paymentConfigPath(base)}.tmp`)).toBe(false)
    expect(config.x402Config().payTo).toBe(ADDRESS)
  })

  it('refuses a malformed address without replacing the prior destination', () => {
    const base = root()
    const config = createServedPaymentConfig({ base, env: {} })
    expect(config.setPayTo(ADDRESS)).toEqual({ ok: true })

    expect(config.setPayTo('0xnot-an-address')).toEqual({
      ok: false,
      reason: 'invalid-pay-to'
    })
    expect(config.x402Config().payTo).toBe(ADDRESS)
  })

  it('keeps COOKREW_PAY_TO as the deployment override', () => {
    const base = root()
    const config = createServedPaymentConfig({ base, env: { COOKREW_PAY_TO: OVERRIDE } })
    expect(config.setPayTo(ADDRESS)).toEqual({ ok: true })
    expect(config.x402Config().payTo).toBe(OVERRIDE)
  })

  it('derives status from the same quote composer and never includes the Stripe key', () => {
    const base = root()
    const config = createServedPaymentConfig({ base, env: {} })
    expect(config.status()).toEqual({
      x402: { ready: false },
      stripe: { ready: false }
    })

    expect(config.setPayTo(ADDRESS)).toEqual({ ok: true })
    expect(config.setStripeSecret(FAKE_STRIPE)).toEqual({ ok: true })
    const status = config.status()
    expect(status).toEqual({
      x402: { ready: true, payTo: ADDRESS },
      stripe: { ready: true, mode: 'test' }
    })
    expect(JSON.stringify(status)).not.toContain(FAKE_STRIPE)
    expect(config.rails()).toEqual(['x402', 'stripe'])
    expect(servedPaymentRails(config.terms({ priceUsd: '1', slug: 'preview' }))).toEqual(
      config.rails()
    )
  })

  it('an invalid persisted shape is unconfigured rather than partly trusted', () => {
    const base = root()
    writeFileSync(paymentConfigPath(base), JSON.stringify({ payTo: 'not-an-address' }))
    expect(createServedPaymentConfig({ base, env: {} }).status().x402).toEqual({ ready: false })
  })
})

describe.skipIf(process.platform === 'win32')('Stripe write-only persistence', () => {
  it('writes 0600, preserves unrelated lines, and replaces only the key line', () => {
    const base = root()
    const file = path.join(base, 'stripe.env')
    writeFileSync(file, 'UNCHANGED=yes\nexport STRIPE_SECRET_KEY="old"\n# keep this\n', {
      mode: 0o644
    })
    const config = createServedPaymentConfig({ base, env: {} })

    expect(config.setStripeSecret(FAKE_STRIPE)).toEqual({ ok: true })
    const body = readFileSync(file, 'utf8')
    expect(body).toContain('UNCHANGED=yes')
    expect(body).toContain('# keep this')
    expect(body).toContain(`STRIPE_SECRET_KEY=${FAKE_STRIPE}`)
    expect(body).not.toContain('STRIPE_SECRET_KEY="old"')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses an invalid key without changing the file', () => {
    const base = root()
    const file = path.join(base, 'stripe.env')
    writeFileSync(file, 'UNCHANGED=yes\n', { mode: 0o600 })
    const config = createServedPaymentConfig({ base, env: {} })

    expect(config.setStripeSecret('not-a-stripe-key')).toEqual({
      ok: false,
      reason: 'invalid-stripe-key'
    })
    expect(readFileSync(file, 'utf8')).toBe('UNCHANGED=yes\n')
  })
})

describe('the Stripe bridge is write-only', () => {
  it('exposes a setter and sanitized status, with no secret getter channel', () => {
    const preload = readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8')
    expect(preload).toContain('servingSetStripeSecret')
    expect(preload).toContain('servingPaymentStatus')
    expect(preload).not.toMatch(/serving(?:Get|Read|Load)StripeSecret/)
    expect(preload).not.toMatch(/serving:payment-stripe-(?:get|read|load)/)
  })
})
