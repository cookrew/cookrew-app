// A CLAUDE DIAL IS A LAUNCH FLAG (owner 2026-11-01: "not typed into the TUI").
//
// Turning claude's model or effort used to type `/model opus` into its pane:
// it raced the prompt box for the same input line, waited out a turn, and
// saved the pick as the machine's default for every later agent. Now the pick
// rewrites the card's launch command and the agent restarts in place on the
// same session, exactly as a route change does. These tests hold both halves:
// what applyTuning asks for, and when main may restart (agent-relaunch.ts).

import { describe, expect, it } from 'vitest'
import { TuneAsks, applyTuning, tuningStateOf, type RelaunchVerdict, type TuneDeps } from '../src/main/agent-tuning'
import { relaunchInPlace, type RelaunchDeps } from '../src/main/agent-relaunch'
import type { TurnPhase } from '../src/shared/turn'
import type { TerminalNodeData } from '../src/shared/model'

function node(over: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 'term-1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/tmp/cookrew-relaunch-fixture',
    orch: false,
    role: null,
    claudeSessionId: '11111111-2222-4333-8444-555555555555',
    position: { x: 0, y: 0 },
    size: { width: 640, height: 420 },
    ...over
  }
}

function tuneDeps(over: { command?: string; verdict?: RelaunchVerdict } = {}): {
  deps: TuneDeps
  typed: string[]
  relaunched: string[]
  asks: TuneAsks
} {
  const typed: string[] = []
  const relaunched: string[] = []
  const asks = new TuneAsks()
  return {
    typed,
    relaunched,
    asks,
    deps: {
      node: (id) => (id === 'term-1' ? node(over.command ? { command: over.command } : {}) : null),
      write: (_id, data) => {
        typed.push(data)
        return 'allow'
      },
      relaunch: (_id, patch) => {
        relaunched.push(patch.command)
        return over.verdict ?? 'restarted'
      },
      asks,
      now: () => 1_793_000_000_000
    }
  }
}

describe('turning a claude dial restarts it on the flag, and types nothing', () => {
  it('relaunches with --model, remembers the ask, and never touches the pane', () => {
    const d = tuneDeps()
    const result = applyTuning(d.deps, 'term-1', 'model', 'opus')
    expect(result).toEqual({ ok: true, ask: { knob: 'model', value: 'opus', at: 1_793_000_000_000 } })
    expect(d.relaunched).toEqual(['claude --model opus'])
    expect(d.typed).toEqual([])
    expect(d.asks.of('term-1')).toHaveLength(1)
  })

  it('replaces the flag the card already carries and keeps the other', () => {
    const d = tuneDeps({ command: 'claude --permission-mode bypassPermissions --model sonnet --effort high' })
    applyTuning(d.deps, 'term-1', 'effort', 'low')
    applyTuning(d.deps, 'term-1', 'model', 'opus')
    expect(d.relaunched).toEqual([
      'claude --permission-mode bypassPermissions --model sonnet --effort low',
      'claude --permission-mode bypassPermissions --effort high --model opus'
    ])
  })

  it('still refuses a value it does not offer, before anything restarts', () => {
    const d = tuneDeps()
    expect(applyTuning(d.deps, 'term-1', 'model', 'claude-opus-4-8').ok).toBe(false)
    expect(applyTuning(d.deps, 'term-1', 'effort', 'ludicrous').ok).toBe(false)
    expect(d.relaunched).toEqual([])
  })

  it('says why when the agent is mid-turn, and remembers no ask', () => {
    const d = tuneDeps({ verdict: 'busy' })
    const result = applyTuning(d.deps, 'term-1', 'model', 'opus')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toMatch(/mid-turn|answer/)
    expect(d.asks.of('term-1')).toEqual([])
  })

  it('keeps the pick for the next start when a restart now would lose the conversation', () => {
    const d = tuneDeps({ verdict: 'unrestorable' })
    const result = applyTuning(d.deps, 'term-1', 'model', 'opus')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toMatch(/next start/)
  })

  it('takes the pick on an agent that is asleep: it wakes on the flag', () => {
    const d = tuneDeps({ verdict: 'asleep' })
    expect(applyTuning(d.deps, 'term-1', 'effort', 'max').ok).toBe(true)
    expect(d.asks.of('term-1')).toHaveLength(1)
  })

  it('tells the picker it restarts the agent, not that it changes the machine default', () => {
    const d = tuneDeps()
    expect(tuningStateOf(d.deps, 'term-1').caveat).toMatch(/restarts/)
    expect(tuningStateOf(d.deps, 'term-1').caveat).not.toMatch(/default/)
  })
})

describe('when main may restart an agent in place', () => {
  function relaunchDeps(over: { phase?: TurnPhase; live?: boolean; restorable?: boolean; gone?: boolean; delivering?: boolean } = {}): {
    deps: RelaunchDeps
    saved: string[]
    respawned: string[]
  } {
    const saved: string[] = []
    const respawned: string[] = []
    return {
      saved,
      respawned,
      deps: {
        node: () => (over.gone ? null : node()),
        phaseOf: () => over.phase,
        delivering: () => over.delivering ?? false,
        save: (_id, patch) => saved.push(patch.command),
        live: () => over.live ?? true,
        restorable: () => over.restorable ?? true,
        respawn: (id) => respawned.push(id)
      }
    }
  }

  it('saves the command and restarts an idle agent that can resume its session', () => {
    for (const phase of [undefined, 'idle', 'replied'] as const) {
      const d = relaunchDeps({ phase })
      expect(relaunchInPlace(d.deps, 'term-1', { command: 'claude --model opus' })).toBe('restarted')
      expect(d.saved).toEqual(['claude --model opus'])
      expect(d.respawned).toEqual(['term-1'])
    }
  })

  it('touches nothing while the agent is working or waiting for an answer', () => {
    for (const phase of ['thinking', 'waiting'] as const) {
      const d = relaunchDeps({ phase })
      expect(relaunchInPlace(d.deps, 'term-1', { command: 'claude --model opus' })).toBe('busy')
      expect(d.saved).toEqual([])
      expect(d.respawned).toEqual([])
    }
  })

  // QA 2026-11-03: a pick fired three seconds after `cookrew ask` restarted
  // the pane while the prompt was still being typed in. The turn tracker
  // still said `replied` (a turn starts only once the agent takes the prompt),
  // so the prompt was lost and its dispatch kept the agent's slot: every later
  // ask answered busy.
  it('touches nothing while a prompt is being delivered, though no turn has started yet', () => {
    const d = relaunchDeps({ phase: 'replied', delivering: true })
    expect(relaunchInPlace(d.deps, 'term-1', { command: 'claude --model opus' })).toBe('busy')
    expect(d.saved).toEqual([])
    expect(d.respawned).toEqual([])
  })

  it('saves but does not restart an agent with no process: it wakes on the new command', () => {
    const d = relaunchDeps({ live: false })
    expect(relaunchInPlace(d.deps, 'term-1', { command: 'claude --model opus' })).toBe('asleep')
    expect(d.saved).toEqual(['claude --model opus'])
    expect(d.respawned).toEqual([])
  })

  it('saves but does not restart when the session could not be resumed', () => {
    const d = relaunchDeps({ restorable: false })
    expect(relaunchInPlace(d.deps, 'term-1', { command: 'claude --model opus' })).toBe('unrestorable')
    expect(d.saved).toEqual(['claude --model opus'])
    expect(d.respawned).toEqual([])
  })

  it('answers gone for a card that is not there', () => {
    const d = relaunchDeps({ gone: true })
    expect(relaunchInPlace(d.deps, 'term-1', { command: 'claude --model opus' })).toBe('gone')
    expect(d.saved).toEqual([])
  })
})

// QA 2026-11-03: `--model sonnet` on a card routed to claude-opus-5-5 ran
// group/smart (claude's settings env outranks the route's). A routed card's
// model is its route, so the pick moves the route (claude-model-route.ts).
describe('a model pick on a routed card moves its route', () => {
  const CATALOG = ['group/smart', 'claude/claude-haiku-5-5', 'claude/claude-sonnet-5-5', 'claude/claude-opus-5-5']
  function routedDeps(over: { routed: boolean; command?: string; route?: string }): { deps: TuneDeps; patches: unknown[] } {
    const patches: unknown[] = []
    return {
      patches,
      deps: {
        node: (id) => (id === 'term-1' ? node({ command: over.command ?? 'claude --effort low', ...(over.route ? { route: over.route } : {}) }) : null),
        write: () => 'allow',
        relaunch: (_id, patch) => {
          patches.push(patch)
          return 'restarted'
        },
        routeFor: () => ({ routed: over.routed, catalog: CATALOG }),
        asks: new TuneAsks(),
        now: () => 1_793_000_000_000
      }
    }
  }

  it("routes to the gateway's model and drops the flag that would outrank it", () => {
    const d = routedDeps({ routed: true, command: 'claude --effort low --model opus' })
    expect(applyTuning(d.deps, 'term-1', 'model', 'sonnet').ok).toBe(true)
    expect(d.patches).toEqual([{ command: 'claude --effort low', route: 'claude/claude-sonnet-5-5' }])
  })

  it('says so when the gateway lists no such model, and restarts nothing', () => {
    const d = routedDeps({ routed: true })
    const result = applyTuning(d.deps, 'term-1', 'model', 'fable')
    expect(result.ok ? '' : result.reason).toMatch(/gateway lists no fable/)
    expect(d.patches).toEqual([])
  })

  it('keeps effort a flag on a routed card, and a direct card its alias', () => {
    const routed = routedDeps({ routed: true })
    applyTuning(routed.deps, 'term-1', 'effort', 'max')
    const direct = routedDeps({ routed: false })
    applyTuning(direct.deps, 'term-1', 'model', 'haiku')
    expect(routed.patches).toEqual([{ command: 'claude --effort max' }])
    expect(direct.patches).toEqual([{ command: 'claude --effort low --model haiku' }])
  })
})

describe('a pick the card already carries', () => {
  it('restarts nothing, even mid-turn', () => {
    const saved: unknown[] = []
    const deps: RelaunchDeps = {
      node: () => node({ command: 'claude --effort low', route: 'claude/claude-opus-5-5' }),
      phaseOf: () => 'thinking',
      delivering: () => false,
      save: (_id, patch) => saved.push(patch),
      live: () => true,
      restorable: () => true,
      respawn: () => saved.push('respawn')
    }
    expect(relaunchInPlace(deps, 'term-1', { command: 'claude --effort low' })).toBe('unchanged')
    expect(relaunchInPlace(deps, 'term-1', { command: 'claude --effort low', route: 'claude/claude-opus-5-5' })).toBe('unchanged')
    expect(saved).toEqual([])
  })
})

// QA 2026-11-03: the rail read `group/smart ! opus` — an MDL ask, settled
// once, then outlived by an RTE pick, and a re-pick that sent nothing.
describe('asks the rail should not be holding', () => {
  it('records none for a pick the card already carries', () => {
    const asks = new TuneAsks()
    const deps: TuneDeps = {
      node: () => node({ command: 'claude --effort low' }),
      write: () => 'allow',
      relaunch: () => 'unchanged',
      asks
    }
    expect(applyTuning(deps, 'term-1', 'effort', 'low').ok).toBe(true)
    expect(asks.of('term-1')).toEqual([])
  })

  it('forgets one knob and keeps the other', () => {
    const asks = new TuneAsks()
    asks.record('term-1', { knob: 'model', value: 'opus', at: 1 })
    asks.record('term-1', { knob: 'effort', value: 'low', at: 2 })
    asks.forgetKnob('term-1', 'model')
    expect(asks.of('term-1')).toEqual([{ knob: 'effort', value: 'low', at: 2 }])
    asks.forgetKnob('term-1', 'effort')
    expect(asks.of('term-1')).toEqual([])
  })
})
