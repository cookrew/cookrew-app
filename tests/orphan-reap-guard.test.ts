import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MAX_ORPHAN_CLOSES_PER_BOOT, planOrphanReap, reapOrphansOn } from '../src/main/orphan-reap'
import { sessionNameFor } from '../src/main/pty'
import { HerdrHostMultiplexer } from '../src/main/herdr-host-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'

// The 2026-09-18 incident: a second Cookrew with an empty store booted on the
// same herdr session and closed all 56 live panes as orphans in 52 s.

const ids = (n: number, prefix: string): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}-0000-0000-0000-000000000000`)

const FLEET = ids(56, 'f')
const FLEET_NAMES = FLEET.map(sessionNameFor)
/** What seedConductorIfEmpty gives an empty store before the reap runs. */
const SEEDED_ORCH = ['5eed0000-0000-0000-0000-000000000000']

describe('planOrphanReap', () => {
  it('an EMPTY store closes nothing, however many panes are live', () => {
    const plan = planOrphanReap(FLEET_NAMES, [])
    expect(plan.close).toEqual([])
    expect(plan.held).toBe(56)
    expect(plan.reason).toMatch(/none of the 56/)
  })

  it('an UNFAMILIAR store (only a freshly seeded orch) closes nothing', () => {
    const plan = planOrphanReap(FLEET_NAMES, SEEDED_ORCH)
    expect(plan.close).toEqual([])
    expect(plan.held).toBe(56)
  })

  it('a familiar store still reaps its own few leaks', () => {
    const owned = FLEET.slice(0, 54)
    const plan = planOrphanReap(FLEET_NAMES, owned)
    expect(plan.close).toEqual(FLEET_NAMES.slice(54))
    expect(plan.reason).toBeNull()
  })

  it('reaps exactly the cap', () => {
    const owned = FLEET.slice(0, 56 - MAX_ORPHAN_CLOSES_PER_BOOT)
    expect(planOrphanReap(FLEET_NAMES, owned).close).toHaveLength(MAX_ORPHAN_CLOSES_PER_BOOT)
  })

  it('stops entirely above the cap — closes NONE, not the first few', () => {
    const owned = FLEET.slice(0, 56 - MAX_ORPHAN_CLOSES_PER_BOOT - 1)
    const plan = planOrphanReap(FLEET_NAMES, owned)
    expect(plan.close).toEqual([])
    expect(plan.held).toBe(MAX_ORPHAN_CLOSES_PER_BOOT + 1)
    expect(plan.reason).toMatch(/cap/)
  })

  it('never counts a foreign session toward anything', () => {
    const plan = planOrphanReap(['0', 'my-editor', ...FLEET_NAMES.slice(0, 2)], FLEET.slice(0, 1))
    expect(plan.close).toEqual([FLEET_NAMES[1]])
  })
})

// ---------------------------------------------------------------------------
// The same through the REAL herdr backend over a fake runner: count the
// `pane close` commands that would have reached the server.
// ---------------------------------------------------------------------------

interface Call {
  args: string[]
}

function fakeHerdr(labels: string[]): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  const panes = labels.map((label, i) => ({ pane_id: `w1:p${i + 1}`, label, workspace_id: 'w1' }))
  return {
    calls,
    run: (_file, args) => {
      calls.push({ args })
      if (args[0] === 'pane' && args[1] === 'list') {
        return JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes } })
      }
      throw new Error(`unexpected herdr ${args.join(' ')}`)
    },
    runQuiet: (_file, args) => {
      calls.push({ args })
    },
    probe: (_file, args) => {
      calls.push({ args })
      return true
    }
  }
}

const closes = (calls: Call[]): string[] =>
  calls.filter((c) => c.args[0] === 'pane' && c.args[1] === 'close').map((c) => c.args[2])

function herdr(runner: CommandRunner): HerdrHostMultiplexer {
  return new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: path.join(tmpdir(), 'never-written.toml'),
    runner
  })
}

describe('reapOrphansOn (herdr over a fake runner)', () => {
  const quiet = (): void => undefined

  it('the incident replay: empty store, 56 live panes -> zero pane close', () => {
    const runner = fakeHerdr(FLEET_NAMES)
    const reaped = reapOrphansOn(herdr(runner), SEEDED_ORCH, { claimHeld: true, log: quiet })
    expect(reaped).toEqual([])
    expect(closes(runner.calls)).toEqual([])
  })

  it('an instance that does not hold the session claim closes nothing, even for a familiar store', () => {
    const runner = fakeHerdr(FLEET_NAMES)
    const reaped = reapOrphansOn(herdr(runner), FLEET.slice(0, 55), { claimHeld: false, log: quiet })
    expect(reaped).toEqual([])
    expect(closes(runner.calls)).toEqual([])
    // It does not even list: the session is not this instance's to look at.
    expect(runner.calls.filter((c) => c.args[0] === 'pane')).toEqual([])
  })

  it('the owner with a familiar store closes exactly its leaked panes', () => {
    const runner = fakeHerdr(FLEET_NAMES)
    const reaped = reapOrphansOn(herdr(runner), FLEET.slice(0, 54), { claimHeld: true, log: quiet })
    expect(reaped).toEqual(FLEET_NAMES.slice(54))
    expect(closes(runner.calls)).toEqual(['w1:p55', 'w1:p56'])
  })

  it('logs why it held back', () => {
    const lines: string[] = []
    reapOrphansOn(herdr(fakeHerdr(FLEET_NAMES)), [], { claimHeld: true, log: (l) => lines.push(l) })
    expect(lines.join('\n')).toMatch(/closing none/i)
  })
})
