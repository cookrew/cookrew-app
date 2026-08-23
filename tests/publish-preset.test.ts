import { describe, expect, it } from 'vitest'
import { publishPreset, type PublishDeps } from '../src/main/publish-preset'

// THE AUTHOR JOURNEY, as one owner action.
//
// Magpie's give-up #1: zero of 40 controls mention publish/export/sell, no
// publish IPC, no registry client — publishing took her ~140 hand-written
// lines. Every primitive already existed (scrub, manifest, sign); what did not
// exist was anything connecting them. This is that connection, and these tests
// are about its ORDER, because the order is the whole safety property.

const SNAPSHOT = { name: 'Research Crew', nodes: [], connections: [], turns: {} } as never
const GOOD_PAYOUT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

function deps(over: Partial<PublishDeps> = {}): PublishDeps & { pushed: unknown[] } {
  const pushed: unknown[] = []
  return {
    hosts: () => ['registry.example.com'],
    hostHelp: () => 'set COOKREW_REGISTRY_HOST',
    scrub: () => ({ ok: true, snapshot: SNAPSHOT, report: { findings: [] } }) as never,
    manifest: () =>
      ({ ok: true, manifest: { presetId: 'p1', version: 1 }, teamBytes: Buffer.from('x') }) as never,
    sign: (manifest) => ({ ...manifest, signature: 'sig' }) as never,
    push: async (input) => {
      pushed.push(input)
      return { presetId: 'p1' }
    },
    pushed,
    ...over
  } as PublishDeps & { pushed: unknown[] }
}

const run = (d: PublishDeps, over: Record<string, unknown> = {}) =>
  publishPreset(d, { snapshot: SNAPSHOT, handle: 'drej', ...over })

describe('one owner action, and the order it runs in', () => {
  it('publishes and returns an install URL the author can share', async () => {
    const result = await run(deps())
    expect(result).toMatchObject({ ok: true, presetId: 'p1', host: 'registry.example.com' })
    expect(result.ok === true && result.installUrl).toContain('registry.example.com')
    expect(result.ok === true && result.installUrl).toContain('p1')
  })

  it('checks the HOST FIRST — before scrubbing, and before signing anything', async () => {
    // Order as a safety property, not tidiness: we must not build a SIGNED
    // artifact carrying an author's payout address before we know where it is
    // going. Discovering there is no recipient after signing is how a signed
    // manifest ends up looking for a home.
    const steps: string[] = []
    const d = deps({
      hosts: () => [],
      scrub: () => {
        steps.push('scrub')
        return { ok: true, snapshot: SNAPSHOT, report: { findings: [] } } as never
      },
      sign: (m) => {
        steps.push('sign')
        return m
      }
    })
    const result = await run(d)
    expect(result.ok === false && result.step).toBe('host')
    expect(steps).toEqual([])
  })

  it('the host refusal carries the instruction, not just a no', async () => {
    const result = await run(deps({ hosts: () => [], hostHelp: () => 'set COOKREW_REGISTRY_HOST' }))
    expect(result.ok === false && result.reason).toContain('COOKREW_REGISTRY_HOST')
  })
})

describe('the payout gate — R27, at publish', () => {
  it('refuses a PRICED publish with an unverifiable payout address', async () => {
    // The address is well-formed and all-lowercase, so it carries no checksum.
    // Publish is the last moment a human is present to fix it.
    const result = await run(deps(), {
      pricing: { model: 'one-time', amount: '2.50', asset: 'USDC' },
      payout: { address: GOOD_PAYOUT.toLowerCase(), chain: 'base' }
    })
    expect(result.ok === false && result.step).toBe('payout')
    expect(result.ok === false && result.reason).toMatch(/checksum|verif/i)
  })

  it('offers the checksummed form so the fix is a paste', async () => {
    const result = await run(deps(), {
      pricing: { model: 'one-time', amount: '2.50', asset: 'USDC' },
      payout: { address: GOOD_PAYOUT.toLowerCase(), chain: 'base' }
    })
    expect(result.ok === false && result.suggestion).toBe(GOOD_PAYOUT)
  })

  it('refuses a PRICED publish with NO payout address at all (R27)', async () => {
    const result = await run(deps(), { pricing: { model: 'one-time', amount: '2.50', asset: 'USDC' } })
    expect(result.ok === false && result.step).toBe('payout')
  })

  it('refuses a priced publish with no CHAIN — right address, wrong network is money gone', async () => {
    const result = await run(deps(), {
      pricing: { model: 'one-time', amount: '2.50', asset: 'USDC' },
      payout: { address: GOOD_PAYOUT, chain: '' }
    })
    expect(result.ok === false && result.step).toBe('payout')
    expect(result.ok === false && result.reason).toMatch(/chain|network/i)
  })

  it('allows a FREE publish with no payout — nothing is being collected', async () => {
    const result = await run(deps())
    expect(result.ok).toBe(true)
  })

  it('treats a zero-amount pricing block as free, not as a broken charge', async () => {
    const result = await run(deps(), {
      pricing: { model: 'one-time', amount: '0', asset: 'USDC' }
    })
    expect(result.ok).toBe(true)
  })

  it('treats a NON-NUMERIC amount as priced, so the payout gate still runs', async () => {
    // A malformed charge is not a free preset. Reading it as free would skip
    // the one gate that protects the author's money.
    const result = await run(deps(), {
      pricing: { model: 'one-time', amount: 'two fifty', asset: 'USDC' }
    })
    expect(result.ok === false && result.step).toBe('payout')
  })

  it('never pushes when the payout gate refuses', async () => {
    const d = deps()
    await run(d, { pricing: { model: 'one-time', amount: '2.50', asset: 'USDC' } })
    expect(d.pushed).toEqual([])
  })
})

describe('the scrub is a gate, not a report', () => {
  it('refuses when the scrub blocks, naming the step', async () => {
    const d = deps({
      scrub: () =>
        ({ ok: false, report: { findings: [{ kind: 'secret', where: 'cmd' }] } }) as never
    })
    const result = await run(d)
    expect(result.ok === false && result.step).toBe('scrub')
    expect(d.pushed).toEqual([])
  })

  it('never signs a snapshot the scrub refused', async () => {
    let signed = 0
    const d = deps({
      scrub: () => ({ ok: false, report: { findings: [] } }) as never,
      sign: (m) => {
        signed += 1
        return m
      }
    })
    await run(d)
    expect(signed).toBe(0)
  })
})

describe('the push, and what a failed one means', () => {
  it('signs BEFORE pushing, and pushes what it signed', async () => {
    const d = deps()
    await run(d)
    expect(d.pushed).toHaveLength(1)
    expect((d.pushed[0] as { manifest: { signature: string } }).manifest.signature).toBe('sig')
  })

  it('reports a push failure as its own step, so the author knows nothing landed', async () => {
    const d = deps({
      push: async () => {
        throw new Error('registry refused: 503')
      }
    })
    const result = await run(d)
    expect(result.ok === false && result.step).toBe('push')
    expect(result.ok === false && result.reason).toMatch(/503/)
  })

  it('does not claim an install URL for a publish that did not land', async () => {
    const d = deps({
      push: async () => {
        throw new Error('nope')
      }
    })
    const result = await run(d)
    expect(result.ok).toBe(false)
    expect((result as { installUrl?: string }).installUrl).toBeUndefined()
  })
})
