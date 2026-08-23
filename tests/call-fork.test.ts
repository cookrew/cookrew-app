import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cutCallVersion, type CallForkDeps } from '../src/main/call-fork'
import { PinStore } from '../src/main/pin-store'

/**
 * FORK AND PIN, TOGETHER (④ · S3).
 *
 * The non-splittable pair, against Forge's REAL pin store. §10's invariant
 * becomes checkable exactly here: a call cuts a version, the version is
 * numbered and persisted, and the original is never the thing that runs.
 */

const SOURCE = 'db9b45d0-1793-4ca3-904a-696374e6446a'

let base = ''
let pins: PinStore
let clock = 1_700_000_000_000

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-call-fork-'))
  pins = new PinStore(base)
  clock = 1_700_000_000_000
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const deps = (over: Partial<CallForkDeps> = {}): CallForkDeps => ({
  fork: (sourceId, turnIndex) => ({ id: `fork-of-${sourceId}-T${turnIndex}`, name: `A ⑂T${turnIndex}` }),
  turnsOf: () => [{ index: 5 }, { index: 6 }, { index: 7 }],
  scrollLineOf: () => 4200,
  pins: { list: (id) => pins.list(id), add: (id, pin) => pins.add(id, pin) },
  now: () => clock,
  ...over
})

describe('cutCallVersion — a call cuts a version', () => {
  it('forks at the LATEST completed turn', () => {
    const version = cutCallVersion(deps(), SOURCE)
    expect(version.forkId).toBe(`fork-of-${SOURCE}-T7`)
    expect(version.pin.atIndex).toBe(7)
  })

  it('persists the pin against the ORIGINAL, not the fork', () => {
    // §10: a pin marks "the transcript point the version was cut" — a point
    // that exists on the source's rail, which is where lineage reads.
    const version = cutCallVersion(deps(), SOURCE)
    expect(pins.list(SOURCE)).toEqual([version.pin])
    expect(pins.list(version.forkId)).toEqual([])
  })

  it('numbers versions monotonically across calls', () => {
    expect(cutCallVersion(deps(), SOURCE).pin.version).toBe(1)
    expect(cutCallVersion(deps(), SOURCE).pin.version).toBe(2)
    expect(pins.list(SOURCE).map((p) => p.version)).toEqual([1, 2])
  })

  it('continues the numbering an import already started', () => {
    // A buyer's v1 came from planPresetImport; a remote call must not reuse it.
    pins.add(SOURCE, { version: 1, atIndex: 0, scrollLine: 0, cutAt: clock })
    expect(cutCallVersion(deps(), SOURCE).pin.version).toBe(2)
  })

  it('records the scroll coordinate a jump needs', () => {
    expect(cutCallVersion(deps(), SOURCE).pin.scrollLine).toBe(4200)
  })

  it('records an unreadable scroll position as 0, never a guess', () => {
    const version = cutCallVersion(deps({ scrollLineOf: () => null }), SOURCE)
    expect(version.pin.scrollLine).toBe(0)
  })

  it('stamps the cut with the clock it was given', () => {
    expect(cutCallVersion(deps(), SOURCE).pin.cutAt).toBe(clock)
  })
})

describe('cutCallVersion — a failure leaves no half-formed version', () => {
  it('refuses a source with no completed turns, and writes no pin', () => {
    expect(() => cutCallVersion(deps({ turnsOf: () => [] }), SOURCE)).toThrow(/no completed turns/)
    expect(pins.list(SOURCE)).toEqual([])
  })

  it('does not fork a source it cannot pin', () => {
    const fork = vi.fn(() => ({ id: 'x', name: 'x' }))
    expect(() => cutCallVersion(deps({ turnsOf: () => [], fork }), SOURCE)).toThrow()
    expect(fork).not.toHaveBeenCalled()
  })

  it('burns no version number when the fork itself fails', () => {
    // A number recorded for a fork that was never made would make the NEXT cut
    // skip, and §10's versions are meant to be consecutive and addressable.
    const failing = deps({
      fork: () => {
        throw new Error('spawn refused')
      }
    })
    expect(() => cutCallVersion(failing, SOURCE)).toThrow(/spawn refused/)
    expect(pins.list(SOURCE)).toEqual([])
    expect(cutCallVersion(deps(), SOURCE).pin.version).toBe(1)
  })

  it('asks for the fork BEFORE persisting the pin', () => {
    const order: string[] = []
    cutCallVersion(
      deps({
        fork: (sourceId, turnIndex) => {
          order.push('fork')
          return { id: `f-${turnIndex}`, name: 'f' }
        },
        pins: {
          list: (id) => pins.list(id),
          add: (id, pin) => {
            order.push('pin')
            pins.add(id, pin)
          }
        }
      }),
      SOURCE
    )
    expect(order).toEqual(['fork', 'pin'])
  })
})
