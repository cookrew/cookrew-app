import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadStripeSecret, stripeEnvPath } from '../src/main/stripe-config'

const roots: string[] = []

function root(): string {
  const base = path.join(tmpdir(), `cookrew-stripe-config-${process.pid}-${roots.length}`)
  roots.push(base)
  mkdirSync(base, { recursive: true })
  return base
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

describe('the Stripe secret boundary', () => {
  it('reads only the named value from a 0600 owner file', () => {
    const base = root()
    const file = stripeEnvPath(base)
    writeFileSync(file, 'UNRELATED=ignored\nexport STRIPE_SECRET_KEY="configured-for-test"\n', {
      mode: 0o600
    })

    expect(loadStripeSecret({ base })).toBe('configured-for-test')
  })

  it('has no ambient environment fallback', () => {
    const prior = process.env.STRIPE_SECRET_KEY
    process.env.STRIPE_SECRET_KEY = 'ambient-must-not-win'
    try {
      expect(loadStripeSecret({ base: root() })).toBeNull()
    } finally {
      if (prior === undefined) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = prior
    }
  })

  it('refuses a file that is not exactly 0600 without logging its contents', () => {
    const base = root()
    const file = stripeEnvPath(base)
    writeFileSync(file, 'STRIPE_SECRET_KEY=must-not-appear-in-log\n', { mode: 0o600 })
    chmodSync(file, 0o644)
    const logs: string[] = []

    expect(loadStripeSecret({ base, log: (line) => logs.push(line) })).toBeNull()
    expect(logs).toEqual([`stripe: ignoring ${file} — chmod 600 it`])
    expect(logs.join('\n')).not.toContain('must-not-appear')
  })

  it('treats a missing key as an unconfigured rail', () => {
    const base = root()
    writeFileSync(stripeEnvPath(base), 'OTHER=value\n', { mode: 0o600 })
    expect(loadStripeSecret({ base })).toBeNull()
  })
})
