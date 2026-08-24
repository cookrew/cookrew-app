import { describe, expect, it } from 'vitest'
import { publishFromShelf, saveToShelf, type ShelfDeps } from '../src/main/publish-preset'

// R29 — PUBLISH TAKES A SAVED PRESET, NOT LIVE CANVAS STATE.
//
// The reshape is an improvement rather than a relocation. Publishing from the
// shelf means the artifact that ships is byte-identical to the one the author
// reviewed and scrubbed at save time: there is no window in which the canvas
// moves between what they approved and what leaves. It also makes publish
// idempotent over a content address instead of re-deriving a manifest from
// state that has since changed.
//
// WHO GETS THIS maps to exactly the gate configurations that already exist:
//   just-me → no registry call AT ALL
//   free    → registry, identity gate (401)
//   priced  → registry, payment gate (402), and the payout checks apply

const PRESET_ID = 'sha256-0000000000000000000000000000000000000000000000000000000000000001'
const GOOD_PAYOUT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const PRICING = { model: 'one-time' as const, amount: '2.50', asset: 'USDC' as const }

function deps(over: Partial<ShelfDeps> = {}): ShelfDeps & { pushed: unknown[]; hostReads: number } {
  const state = { pushed: [] as unknown[], hostReads: 0 }
  return {
    hosts: () => {
      state.hostReads += 1
      return ['registry.example.com']
    },
    hostHelp: () => 'set COOKREW_REGISTRY_HOST',
    readShelf: () =>
      ({ manifest: { id: PRESET_ID, version: 1 }, teamBytes: Buffer.from('team') }) as never,
    push: async (input) => {
      state.pushed.push(input)
      return { presetId: PRESET_ID }
    },
    setVisibility: () => undefined,
    get pushed() {
      return state.pushed
    },
    get hostReads() {
      return state.hostReads
    },
    ...over
  } as ShelfDeps & { pushed: unknown[]; hostReads: number }
}

describe('JUST ME means no registry call at all', () => {
  it('publishes nothing and reports it kept the preset private', async () => {
    const d = deps()
    const result = await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'just-me' })
    expect(result).toMatchObject({ ok: true, visibility: 'just-me', published: false })
  })

  it('never pushes', async () => {
    const d = deps()
    await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'just-me' })
    expect(d.pushed).toEqual([])
  })

  it('never even asks which hosts are recognised', async () => {
    // Structural, not incidental: "no registry call" has to mean the registry
    // is not consulted in any way, including to decide whether it could be.
    // An unconfigured host must not be able to fail a private save.
    const d = deps({ hosts: () => [] })
    const result = await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'just-me' })
    expect(result.ok).toBe(true)
    expect(d.hostReads).toBe(0)
  })

  it('succeeds even with no shelf entry read — nothing leaves, so nothing is needed', async () => {
    const d = deps({
      readShelf: () => {
        throw new Error('should not be read')
      }
    })
    await expect(
      publishFromShelf(d, { presetId: PRESET_ID, visibility: 'just-me' })
    ).resolves.toMatchObject({ ok: true })
  })

  it('records the visibility locally, so the shelf knows it is private', async () => {
    const seen: unknown[] = []
    const d = deps({ setVisibility: (id, v) => void seen.push([id, v]) })
    await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'just-me' })
    expect(seen).toEqual([[PRESET_ID, 'just-me']])
  })
})

describe('FREE — the registry, behind the identity gate', () => {
  it('pushes what the shelf holds, not a freshly derived manifest', async () => {
    // The point of the reshape: the bytes that ship are the bytes reviewed.
    const d = deps()
    const result = await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'free' })
    expect(result).toMatchObject({ ok: true, published: true, visibility: 'free' })
    expect((d.pushed[0] as { manifest: { id: string } }).manifest.id).toBe(PRESET_ID)
  })

  it('needs no payout address — nothing is being collected', async () => {
    const result = await publishFromShelf(deps(), { presetId: PRESET_ID, visibility: 'free' })
    expect(result.ok).toBe(true)
  })

  it('still refuses when no host is configured, with the instruction', async () => {
    const d = deps({ hosts: () => [] })
    const result = await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'free' })
    expect(result.ok === false && result.step).toBe('host')
    expect(d.pushed).toEqual([])
  })

  it('refuses a preset that is not on the shelf', async () => {
    const d = deps({ readShelf: () => null })
    const result = await publishFromShelf(d, { presetId: PRESET_ID, visibility: 'free' })
    expect(result.ok === false && result.step).toBe('shelf')
  })
})

describe('PRICED — the payout checks still apply, at the same moment', () => {
  it('refuses an unverifiable payout address', async () => {
    const d = deps()
    const result = await publishFromShelf(d, {
      presetId: PRESET_ID,
      visibility: 'priced',
      pricing: PRICING,
      payout: { address: GOOD_PAYOUT.toLowerCase(), chain: 'base' }
    })
    expect(result.ok === false && result.step).toBe('payout')
    expect(d.pushed).toEqual([])
  })

  it('refuses priced with no pricing block — the mode and the terms must agree', async () => {
    const result = await publishFromShelf(deps(), {
      presetId: PRESET_ID,
      visibility: 'priced',
      payout: { address: GOOD_PAYOUT, chain: 'base' }
    })
    expect(result.ok === false && result.step).toBe('payout')
  })

  it('publishes when the address verifies and the chain is named', async () => {
    const d = deps()
    const result = await publishFromShelf(d, {
      presetId: PRESET_ID,
      visibility: 'priced',
      pricing: PRICING,
      payout: { address: GOOD_PAYOUT, chain: 'base' }
    })
    expect(result).toMatchObject({ ok: true, published: true, visibility: 'priced' })
  })

  it('checks the payout BEFORE reading the shelf or pushing', async () => {
    // Cheapest refusal first, and nothing is read for a publish that cannot
    // proceed. The author fixes one thing at a time.
    let reads = 0
    const d = deps({
      readShelf: () => {
        reads += 1
        return { manifest: { id: PRESET_ID, version: 1 }, teamBytes: Buffer.from('t') } as never
      }
    })
    await publishFromShelf(d, {
      presetId: PRESET_ID,
      visibility: 'priced',
      pricing: PRICING,
      payout: { address: 'nonsense', chain: 'base' }
    })
    expect(reads).toBe(0)
  })
})

describe('saveToShelf — the private write that publish later reads', () => {
  it('scrubs, signs and installs, touching no registry', async () => {
    const installed: unknown[] = []
    const result = await saveToShelf(
      {
        scrub: () => ({ ok: true, snapshot: {}, report: { findings: [] } }) as never,
        manifest: () =>
          ({ ok: true, manifest: { id: PRESET_ID, version: 1 }, teamBytes: Buffer.from('t') }) as never,
        sign: (m) => ({ ...m, sig: 'ed25519:x' }) as never,
        install: (preset) => void installed.push(preset)
      },
      { snapshot: {}, handle: 'drej' }
    )
    expect(result).toMatchObject({ ok: true, presetId: PRESET_ID })
    expect(installed).toHaveLength(1)
  })

  it('refuses a blocked scrub, and installs nothing', async () => {
    const installed: unknown[] = []
    const result = await saveToShelf(
      {
        scrub: () => ({ ok: false, report: { findings: [] } }) as never,
        manifest: () => ({ ok: true }) as never,
        sign: (m) => m,
        install: (preset) => void installed.push(preset)
      },
      { snapshot: {}, handle: 'drej' }
    )
    expect(result.ok).toBe(false)
    expect(installed).toEqual([])
  })
})
