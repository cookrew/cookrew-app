// The merge gate for step 2, as a test rather than a hope.
//
// Step 2 lets N workspaces hold live runtimes at once, which multiplies
// `attached` — the exact term behind wave C's blow-up, where cost was
// O(attached x panes) and /api/activity went 190ms to 6.85s with herdr at 74%
// CPU (ef5e13c post-mortem).
//
// The baseline probe measured the tax precisely (34 panes, 2026-08-20):
//
//   K labels   unbatched p50   batched p50   multiplier
//   1          25.8ms          32.5ms        0.8x
//   10         168ms           12.7ms        13.2x
//   34         623.2ms         13.9ms        44.8x
//
// Batched is FLAT in K; unbatched is linear. The whole safety margin is that
// every session's reattach stays inside one attach batch. So what is pinned
// here is fork COUNT, which is deterministic and does not need a running app:
// resolving a whole session's panes costs ONE `pane list`, so N resident
// sessions cost N — O(sessions), never O(sessions x panes).

import { describe, expect, it } from 'vitest'
import { HerdrHostMultiplexer } from '../src/main/herdr-host-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'
import { PtyOwnership } from '../src/main/pty-scope'

interface Call {
  args: string[]
}

/** Panes for S sessions of P terminals each, labelled the way Cookrew does. */
function panesFor(sessions: number, perSession: number): { pane_id: string; label: string }[] {
  const panes: { pane_id: string; label: string }[] = []
  for (let s = 0; s < sessions; s += 1) {
    for (let p = 0; p < perSession; p += 1) {
      panes.push({ pane_id: `w1:p${s}_${p}`, label: `cookrew_ws${s}term${p}` })
    }
  }
  return panes
}

function runner(panes: unknown[]): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  const reply = JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes } })
  return {
    calls,
    run: (_file, args) => {
      calls.push({ args })
      if (args[0] === 'pane' && args[1] === 'list') return reply
      throw new Error(`unscripted ${args.slice(0, 2).join(' ')}`)
    },
    runQuiet: (_file, args) => void calls.push({ args }),
    probe: (_file, args) => {
      calls.push({ args })
      return true
    }
  } as CommandRunner & { calls: Call[] }
}

const paneListCount = (r: { calls: Call[] }): number =>
  r.calls.filter((c) => c.args[0] === 'pane' && c.args[1] === 'list').length

function backend(r: CommandRunner): HerdrHostMultiplexer {
  return new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner: r })
}

/** Forks spent reattaching S sessions of P terminals each, batched. */
function forksToReattach(sessions: number, perSession: number): number {
  const r = runner(panesFor(sessions, perSession))
  const mux = backend(r)
  for (let s = 0; s < sessions; s += 1) {
    mux.beginAttachBatch()
    for (let p = 0; p < perSession; p += 1) mux.sessionExists(`cookrew_ws${s}term${p}`)
    mux.endAttachBatch()
  }
  return paneListCount(r)
}

describe('fork cost — the O(sessions) gate', () => {
  it('resolutions inside a batch are free, whatever the pane count', () => {
    const r = runner(panesFor(1, 15))
    const mux = backend(r)

    mux.beginAttachBatch()
    const before = paneListCount(r)
    for (let i = 0; i < 15; i += 1) mux.sessionExists(`cookrew_ws0term${i}`)
    const during = paneListCount(r)
    mux.endAttachBatch()

    expect(during - before).toBe(0) // every resolution served from the snapshot
  })

  it('MARGINAL cost of a session is exactly one fork', () => {
    // Stated as a marginal cost because there is a fixed one-fork setup at
    // first availability. What the gate cares about is the slope, and the
    // slope is 1 per session — independent of how many panes each holds.
    const PER = 15
    const one = forksToReattach(1, PER)
    const two = forksToReattach(2, PER)
    const four = forksToReattach(4, PER)

    expect(two - one).toBe(1)
    expect(four - two).toBe(2)
  })

  it('the fixed overhead does NOT grow with panes or sessions', () => {
    // The constant has to stay constant, or "O(sessions)" is a fiction.
    for (const [sessions, per] of [
      [1, 5],
      [1, 15],
      [2, 15],
      [4, 15],
      [8, 5]
    ]) {
      expect(forksToReattach(sessions, per) - sessions).toBe(1)
    }
  })

  it('60 panes across 4 sessions cost 4 forks, not 60', () => {
    // The gate in the terms the baseline priced: unbatched 60-label resolution
    // measured ~45x batched at 34 panes. Batched, four sessions cost four.
    const SESSIONS = 4
    const PER = 15
    const forks = forksToReattach(SESSIONS, PER)

    expect(forks - 1).toBe(SESSIONS)
    expect(forks).toBeLessThan(SESSIONS * PER)
  })

  it('a nested begin does not double-fork', () => {
    // Re-entrancy matters once more than one session can reattach: a second
    // begin inside an open batch must reuse the snapshot, not take another.
    const nested = runner(panesFor(1, 5))
    const nestedMux = backend(nested)
    nestedMux.beginAttachBatch()
    nestedMux.beginAttachBatch()
    nestedMux.sessionExists('cookrew_ws0term0')
    nestedMux.endAttachBatch()

    // Measured against a single begin, so the fixed setup fork cancels out.
    expect(paneListCount(nested)).toBe(forksToReattach(1, 5))
  })

  it('outside a batch each resolution forks — the shape being avoided', () => {
    // Pinned deliberately: this is what the gate is protecting against, and if
    // it ever stops being true the gate above stops meaning anything.
    const r = runner(panesFor(1, 5))
    const mux = backend(r)

    for (let i = 0; i < 5; i += 1) mux.sessionExists(`cookrew_ws0term${i}`)

    // Five labels, five forks — linear, exactly the shape the batch avoids.
    expect(paneListCount(r)).toBe(5)
  })
})

describe('scope teardown touches only its own session', () => {
  it('detaching one session leaves every other session held', () => {
    // The other half of the cost story: a switch must not tear down and
    // rebuild runtimes it is not responsible for. Rebuilding is what made a
    // switch expensive, and doing it to a session nobody asked about is how a
    // background workspace loses its screens.
    const own = new PtyOwnership()
    for (let s = 0; s < 3; s += 1) {
      for (let p = 0; p < 5; p += 1) own.claim(`ws${s}-t${p}`, `ws${s}`)
    }
    expect(own.all()).toHaveLength(15)

    const dropped = own.releaseWorkspace('ws1')

    expect(dropped).toHaveLength(5)
    expect(own.all()).toHaveLength(10)
    expect(own.idsFor('ws0')).toHaveLength(5)
    expect(own.idsFor('ws2')).toHaveLength(5)
  })
})
