import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crewLineCommand } from '../src/main/crew-line-command'
import { MKT_GATE } from '../src/shared/marketplace-copy'

describe('placed crew-line payment state', () => {
  it('never imports a persisted payment reference into a new placed card', () => {
    const command = crewLineCommand('/app/crew-line.mjs', {
      origin: 'http://crew.example',
      slug: 'research',
      payRef: 'stale-proof-must-not-enter-command'
    } as { origin: string; slug: string; payRef: string })
    expect(command).not.toContain('stale-proof-must-not-enter-command')
    expect(command).not.toMatch(/--pay\b/)
    expect(command).toContain(MKT_GATE['mkt.gate.payment.unavailable'])
    expect(command).toContain(MKT_GATE['mkt.gate.payment.unverifiable'])
  })

  it('adds X-Payment only from live /pay state and clears it after terminal outcomes', () => {
    const source = readFileSync(path.join(process.cwd(), 'resources', 'crew-line.mjs'), 'utf8')
    expect(source).not.toMatch(/arg\(['"]pay['"]/)
    expect(source).toContain("if (prompt.startsWith('/pay '))")
    expect(source).toContain("if (payRef) headers['x-payment'] = payRef")
    expect(source).toContain("if (payRef) payRef = '' // spent at session start")
    expect(source).toContain("res.body?.reason === 'payment_unavailable'")
  })
})
