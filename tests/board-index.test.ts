// Collector layer for the Activity Board. The merge rules are pinned in
// board-merge.test.ts; what is pinned HERE is everything the collectors add:
// window parsing, the probe layer staying optional until P4, the registry
// projection, and the debounce that stops a chatty activity stream from
// triggering a whole-fleet recompute per tick.

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BOARD_EVENT_DEBOUNCE_MS,
  PROBE_INTERVAL_MS,
  createProbeSampler,
  probeOnce,
  type ProbeDeps,
  boardSourcesFrom,
  boardWindowMs,
  buildBoard,
  createBoardNotifier,
  type BoardSources
} from '../src/main/board-index'
import { BOARD_WINDOW_MS, BOARD_WINDOW_WIDE_MS, type BoardAgentMeta } from '../src/shared/board'
import { TurnStore } from '../src/main/turn-store'
import type { TerminalActivity, TurnRecord } from '../src/shared/turn'

const NOW = 1_800_000_000_000

function record(over: Partial<TurnRecord> & { index: number }): TurnRecord {
  return { prompt: 'p', reply: 'r', startedAt: NOW - 60_000, endedAt: NOW - 30_000, ...over }
}
function meta(over: Partial<BoardAgentMeta> & { id: string }): BoardAgentMeta {
  return {
    name: 'Agent',
    preset: 'Claude Code',
    role: null,
    cwd: '/tmp',
    workspaceId: 'ws',
    workspaceName: 'WS',
    orch: false,
    active: true,
    ...over
  }
}
function sources(over: Partial<BoardSources> = {}): BoardSources {
  return {
    activeWorkspaceId: () => 'ws',
    live: () => [],
    ledger: () => new Map<string, TurnRecord[]>(),
    registry: () => [],
    now: () => NOW,
    ...over
  }
}

describe('boardWindowMs', () => {
  it('maps the two supported windows', () => {
    expect(boardWindowMs('24h')).toBe(BOARD_WINDOW_MS)
    expect(boardWindowMs('7d')).toBe(BOARD_WINDOW_WIDE_MS)
  })
  it('defaults to 24h for missing/garbage input (never a huge accidental scan)', () => {
    expect(boardWindowMs(undefined)).toBe(BOARD_WINDOW_MS)
    expect(boardWindowMs(null)).toBe(BOARD_WINDOW_MS)
    expect(boardWindowMs('all-time')).toBe(BOARD_WINDOW_MS)
  })
})

describe('buildBoard', () => {
  it('returns rows, summary and the active workspace id together', () => {
    const snapshot = buildBoard(
      sources({
        ledger: () => new Map([['t1', [record({ index: 1, seenAt: NOW })]]]),
        registry: () => [meta({ id: 't1' })]
      })
    )
    expect(snapshot.activeWorkspaceId).toBe('ws')
    expect(snapshot.rows.map((r) => r.terminalId)).toEqual(['t1'])
    expect(snapshot.summary.presetMix).toEqual({ 'Claude Code': 1 })
  })

  it('works with NO probe layer — P4 has not wired tmux sampling yet', () => {
    const snapshot = buildBoard(
      sources({
        ledger: () => new Map([['t1', [record({ index: 1, seenAt: NOW })]]]),
        registry: () => [meta({ id: 't1' })]
      })
    )
    // Degrades to the last known task rather than inventing a live phase.
    expect(snapshot.rows[0].source).toBe('ledger')
  })

  it('passes a supplied probe layer through to the merge', () => {
    const snapshot = buildBoard(
      sources({
        probe: () => new Map([['t1', 'working' as const]]),
        ledger: () => new Map([['t1', [record({ index: 1, seenAt: NOW })]]]),
        registry: () => [meta({ id: 't1' })]
      })
    )
    expect(snapshot.rows[0].source).toBe('probe')
    expect(snapshot.rows[0].phase).toBe('working')
  })

  it('honors the requested window', () => {
    const old = new Map([['t1', [record({ index: 1, endedAt: NOW - 40 * 3600_000, seenAt: NOW })]]])
    const args = { ledger: () => old, registry: () => [meta({ id: 't1' })] }
    expect(buildBoard(sources(args), BOARD_WINDOW_MS).rows).toHaveLength(0)
    expect(buildBoard(sources(args), BOARD_WINDOW_WIDE_MS).rows).toHaveLength(1)
  })
})

describe('boardSourcesFrom — adapting the main-process singletons', () => {
  it('projects registry entries down to the board contract, dropping extras', () => {
    const entry = {
      ...meta({ id: 'a', name: 'Forge' }),
      // AgentRegistryEntry carries more than the board needs.
      command: 'claude',
      sessionRef: 'abc',
      spawnedAt: 1
    }
    const built = boardSourcesFrom({
      store: { focusedId: 'ws-1' },
      turns: { list: () => [] },
      turnStore: { loadAll: () => new Map() },
      agents: { list: () => [entry] }
    })
    expect(built.activeWorkspaceId()).toBe('ws-1')
    expect(built.registry()).toEqual([meta({ id: 'a', name: 'Forge' })])
    expect(Object.keys(built.registry()[0])).not.toContain('command')
  })

  it('omits probe entirely when the runtime has no sampler', () => {
    const built = boardSourcesFrom({
      store: { focusedId: 'ws' },
      turns: { list: () => [] },
      turnStore: { loadAll: () => new Map() },
      agents: { list: () => [] }
    })
    expect(built.probe).toBeUndefined()
  })

  it('reads each layer lazily, so a snapshot always sees current state', () => {
    let calls = 0
    const built = boardSourcesFrom({
      store: { focusedId: 'ws' },
      turns: (() => {
        const t = {
          list: (): TerminalActivity[] => {
            calls += 1
            return []
          }
        }
        return t
      })(),
      turnStore: { loadAll: () => new Map() },
      agents: { list: () => [] }
    })
    built.live()
    built.live()
    expect(calls).toBe(2)
  })
})

describe('createBoardNotifier — debounce', () => {
  it('coalesces a burst into ONE emit', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const notifier = createBoardNotifier(emit)
    for (let i = 0; i < 50; i += 1) notifier.schedule()
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BOARD_EVENT_DEBOUNCE_MS)
    expect(emit).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('allows a new burst after the previous one fired', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const notifier = createBoardNotifier(emit)
    notifier.schedule()
    vi.advanceTimersByTime(BOARD_EVENT_DEBOUNCE_MS)
    notifier.schedule()
    vi.advanceTimersByTime(BOARD_EVENT_DEBOUNCE_MS)
    expect(emit).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('cancel() stops a pending emit (client disconnected)', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const notifier = createBoardNotifier(emit)
    notifier.schedule()
    notifier.cancel()
    vi.advanceTimersByTime(BOARD_EVENT_DEBOUNCE_MS * 4)
    expect(emit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('TurnStore.loadAll — the L3 ledger', () => {
  function storeWith(files: Record<string, unknown>): TurnStore {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), JSON.stringify(body), 'utf8')
    }
    return new TurnStore(dir)
  }

  it('keys every history file by its terminal id', () => {
    const store = storeWith({
      'term-a.json': [record({ index: 1 })],
      'term-b.json': [record({ index: 1 }), record({ index: 2 })]
    })
    const all = store.loadAll()
    expect([...all.keys()].sort()).toEqual(['term-a', 'term-b'])
    expect(all.get('term-b')).toHaveLength(2)
  })

  it('skips non-JSON files, empty histories and corrupt files', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'good.json'), JSON.stringify([record({ index: 1 })]), 'utf8')
    writeFileSync(path.join(dir, 'empty.json'), '[]', 'utf8')
    writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8')
    writeFileSync(path.join(dir, 'notes.txt'), 'ignore me', 'utf8')
    const all = new TurnStore(dir).loadAll()
    expect([...all.keys()]).toEqual(['good'])
  })

  it('returns an empty map when the directory does not exist', () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'nope')
    expect(new TurnStore(missing).loadAll().size).toBe(0)
  })

  it('caches: a file written behind its back is NOT re-read', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify([record({ index: 1 })]), 'utf8')
    const store = new TurnStore(dir)
    expect(store.loadAll().size).toBe(1)
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify([record({ index: 1 })]), 'utf8')
    // Cached on purpose — 129 files / 3.7 MB must not be re-read per request.
    expect(store.loadAll().size).toBe(1)
  })

  it('refreshes incrementally on write, so the board sees new turns', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    const store = new TurnStore(dir)
    expect(store.loadAll().size).toBe(0)
    store.scheduleSave('t1', [record({ index: 1 })])
    store.flushAll()
    expect(store.loadAll().get('t1')).toHaveLength(1)
    store.scheduleSave('t1', [record({ index: 1 }), record({ index: 2 })])
    store.flushAll()
    expect(store.loadAll().get('t1')).toHaveLength(2)
  })

  it('drops a removed terminal from the cache', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    const store = new TurnStore(dir)
    store.scheduleSave('gone', [record({ index: 1 })])
    store.flushAll()
    expect(store.loadAll().has('gone')).toBe(true)
    store.remove('gone')
    expect(store.loadAll().has('gone')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// L2 probe. The board's whole reason for a probe layer: a workspace switch
// detaches its terminals, so the TurnTracker cannot see them and an inactive
// workspace would show history only — unable to answer "who is stuck NOW".
// ---------------------------------------------------------------------------

const WORKING_PANE = '✻ Baking… (esc to interrupt)'
const WAITING_PANE = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
const IDLE_PANE = 'some quiet scrollback\n❯ '

function probeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    listSessions: () => [],
    capturePane: () => '',
    knownTerminalIds: () => [],
    isAttached: () => false,
    sessionNameFor: (id) => `cookrew_${id}`,
    // Stand-ins with the same shape as the real detectors.
    detectWorking: (chunk) => /esc to interrupt/i.test(chunk),
    detectWaiting: (lines) => lines.some((l) => /Do you want to proceed\?/.test(l)),
    ...over
  }
}

describe('probeOnce — only DETACHED panes, only phases it can prove', () => {
  it('reports working for a detached pane showing live work', () => {
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        capturePane: () => WORKING_PANE
      })
    )
    expect(phases.get('t1')).toBe('working')
  })

  it('reports waiting for a detached pane blocked on a human', () => {
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        capturePane: () => WAITING_PANE
      })
    )
    expect(phases.get('t1')).toBe('waiting')
  })

  it('SKIPS attached terminals — L1 already has full fidelity', () => {
    let captured = 0
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        isAttached: () => true,
        capturePane: () => {
          captured += 1
          return WORKING_PANE
        }
      })
    )
    expect(phases.size).toBe(0)
    expect(captured).toBe(0) // never even ran capture-pane
  })

  it('omits an idle detached pane instead of inventing a completion', () => {
    // Honesty rule: the probe cannot know whether a result was seen, so the
    // ledger layer keeps deciding unread vs offline.
    const phases = probeOnce(
      probeDeps({
        listSessions: () => ['cookrew_t1'],
        knownTerminalIds: () => ['t1'],
        capturePane: () => IDLE_PANE
      })
    )
    expect(phases.size).toBe(0)
  })

  it('ignores terminals with no tmux session, and empty captures', () => {
    expect(
      probeOnce(
        probeDeps({ listSessions: () => ['cookrew_other'], knownTerminalIds: () => ['t1'] })
      ).size
    ).toBe(0)
    expect(
      probeOnce(
        probeDeps({
          listSessions: () => ['cookrew_t1'],
          knownTerminalIds: () => ['t1'],
          capturePane: () => ''
        })
      ).size
    ).toBe(0)
  })

  it('does no work at all when tmux has no sessions', () => {
    let listed = 0
    probeOnce(
      probeDeps({
        listSessions: () => {
          listed += 1
          return []
        },
        knownTerminalIds: () => {
          throw new Error('must not enumerate terminals with no tmux server')
        }
      })
    )
    expect(listed).toBe(1)
  })
})

describe('createProbeSampler — cost discipline', () => {
  it('samples on start and caches the result between ticks', () => {
    vi.useFakeTimers()
    let scans = 0
    const sampler = createProbeSampler(
      probeDeps({
        listSessions: () => {
          scans += 1
          return ['cookrew_t1']
        },
        knownTerminalIds: () => ['t1'],
        capturePane: () => WORKING_PANE
      })
    )
    sampler.start()
    expect(sampler.phases().get('t1')).toBe('working')
    const afterStart = scans
    // Reading phases() repeatedly must not re-scan.
    sampler.phases()
    sampler.phases()
    expect(scans).toBe(afterStart)
    sampler.stop()
    vi.useRealTimers()
  })

  it('re-samples on each interval tick while work is detached', () => {
    vi.useFakeTimers()
    let scans = 0
    const sampler = createProbeSampler(
      probeDeps({
        listSessions: () => {
          scans += 1
          return ['cookrew_t1']
        },
        knownTerminalIds: () => ['t1'],
        capturePane: () => WORKING_PANE
      })
    )
    sampler.start()
    const afterStart = scans
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 3)
    expect(scans).toBeGreaterThan(afterStart)
    sampler.stop()
    vi.useRealTimers()
  })

  it('parks itself when nothing is detached — an idle machine pays nothing', () => {
    vi.useFakeTimers()
    const sampler = createProbeSampler(probeDeps({ listSessions: () => [] }))
    sampler.start()
    expect(sampler.running).toBe(true)
    vi.advanceTimersByTime(PROBE_INTERVAL_MS)
    expect(sampler.running).toBe(false)
    vi.useRealTimers()
  })

  it('start() is idempotent and survives a throwing probe', () => {
    vi.useFakeTimers()
    const sampler = createProbeSampler(
      probeDeps({
        listSessions: () => {
          throw new Error('tmux exploded')
        }
      })
    )
    expect(() => sampler.start()).not.toThrow()
    sampler.start()
    expect(sampler.phases().size).toBe(0)
    sampler.stop()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// perf/tempo (2026-09-06): the probe's reach is the DETACHED SET from ONE
// inventory per tick, and with async reads the tick forks nothing inline.
// Before: every tick listed the panes twice (probeOnce, then a detached check)
// and captured each detached pane synchronously on Electron main.
// ---------------------------------------------------------------------------

import { detachedTerminals, mergePartialPass, probeDetachedAsync, runDetachedPass } from '../src/main/board-index'

describe('detachedTerminals — the reach', () => {
  it('is known ∖ attached ∩ live, from the set it is handed', () => {
    let listed = 0
    const deps = probeDeps({
      listSessions: () => {
        listed += 1
        return []
      },
      knownTerminalIds: () => ['attached', 'paneless', 'd1', 'd2'],
      isAttached: (id) => id === 'attached'
    })
    const live = new Set(['cookrew_attached', 'cookrew_d1', 'cookrew_d2'])
    expect(detachedTerminals(deps, live)).toEqual([
      { terminalId: 'd1', session: 'cookrew_d1' },
      { terminalId: 'd2', session: 'cookrew_d2' }
    ])
    expect(detachedTerminals(deps, new Set())).toEqual([])
    expect(listed).toBe(0) // the inventory is the caller's, never re-read
  })

  it('probeOnce accepts a pre-read inventory and reads one itself otherwise', () => {
    let listed = 0
    const deps = probeDeps({
      listSessions: () => {
        listed += 1
        return ['cookrew_t1']
      },
      knownTerminalIds: () => ['t1'],
      capturePane: () => WORKING_PANE
    })
    expect(probeOnce(deps, new Set(['cookrew_t1'])).get('t1')).toBe('working')
    expect(listed).toBe(0)
    probeOnce(deps)
    expect(listed).toBe(1)
  })
})

describe('createProbeSampler — one inventory per tick', () => {
  it('lists the panes exactly once per pass, self-stop included', () => {
    vi.useFakeTimers()
    let listed = 0
    const sampler = createProbeSampler(
      probeDeps({
        listSessions: () => {
          listed += 1
          return ['cookrew_t1']
        },
        knownTerminalIds: () => ['t1'],
        capturePane: () => WORKING_PANE
      })
    )
    sampler.start()
    expect(listed).toBe(1)
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 3)
    expect(listed).toBe(4)
    expect(sampler.running).toBe(true)
    sampler.stop()
    vi.useRealTimers()
  })
})

describe('createProbeSampler — the async tick forks nothing inline', () => {
  const asyncDeps = (over: Partial<ProbeDeps> = {}) => {
    const calls = { listSync: 0, captureSync: 0, listAsync: 0, captureAsync: 0 }
    const deps = probeDeps({
      listSessions: () => {
        calls.listSync += 1
        return ['cookrew_t1', 'cookrew_t2']
      },
      capturePane: () => {
        calls.captureSync += 1
        return WORKING_PANE
      },
      listSessionsAsync: async () => {
        calls.listAsync += 1
        return ['cookrew_t1', 'cookrew_t2']
      },
      capturePaneAsync: async (session) => {
        calls.captureAsync += 1
        return session === 'cookrew_t1' ? WORKING_PANE : WAITING_PANE
      },
      knownTerminalIds: () => ['t1', 't2', 't3'],
      ...over
    })
    return { deps, calls }
  }

  it('reads the inventory and every detached pane through the async seam only', async () => {
    const { deps, calls } = asyncDeps()
    const held: number[] = []
    const sampler = createProbeSampler(deps, PROBE_INTERVAL_MS, { observe: (ms) => held.push(ms) })
    const phases = await sampler.sampleAsync()
    expect(phases.get('t1')).toBe('working')
    expect(phases.get('t2')).toBe('waiting')
    expect(phases.has('t3')).toBe(false) // no pane → the ledger's row
    expect(calls).toEqual({ listSync: 0, captureSync: 0, listAsync: 1, captureAsync: 2 })
    expect(held).toHaveLength(1)
    expect(held[0]).toBeGreaterThanOrEqual(0)
  })

  it('asks herdr first and captures only the panes it has no answer for', async () => {
    const { deps, calls } = asyncDeps({ askedStatus: (id) => (id === 't1' ? 'working' : null) })
    const phases = await probeDetachedAsync(deps, detachedTerminals(deps, new Set(['cookrew_t1', 'cookrew_t2'])))
    expect(phases.get('t1')).toBe('working')
    expect(phases.get('t2')).toBe('waiting')
    expect(calls.captureAsync).toBe(1)
  })

  it('runs the periodic tick on the async reads and never stacks passes', async () => {
    vi.useFakeTimers()
    let release: (() => void) | null = null
    const { deps, calls } = asyncDeps({
      listSessionsAsync: () =>
        new Promise<string[]>((resolve) => {
          calls.listAsync += 1
          release = () => resolve(['cookrew_t1'])
        })
    })
    const sampler = createProbeSampler(deps)
    sampler.start() // kicks one async pass
    expect(calls.listAsync).toBe(1)
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 3) // three ticks while the first pass is still in flight
    expect(calls.listAsync).toBe(1) // single-flight spans the whole awaited pass
    expect(calls.listSync).toBe(0)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(sampler.phases().get('t1')).toBe('working')
    vi.advanceTimersByTime(PROBE_INTERVAL_MS)
    expect(calls.listAsync).toBe(2)
    sampler.stop()
    vi.useRealTimers()
  })

  it('parks itself from the same inventory when nothing is detached', async () => {
    vi.useFakeTimers()
    const { deps, calls } = asyncDeps({ listSessionsAsync: async () => [] })
    const sampler = createProbeSampler(deps)
    sampler.start()
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(sampler.running).toBe(false)
    expect(calls.listSync).toBe(0)
    vi.useRealTimers()
  })
})

describe('createProbeSampler — a read can wait for the pass it kicked', () => {
  it('warm() resolves with the fresh pass, not the map from before the park', async () => {
    let release: (() => void) | null = null
    let listed = 0
    const sampler = createProbeSampler(
      probeDeps({
        listSessionsAsync: () =>
          new Promise<string[]>((resolve) => {
            listed += 1
            release = () => resolve(['cookrew_t1'])
          }),
        capturePaneAsync: async () => WORKING_PANE,
        knownTerminalIds: () => ['t1']
      })
    )
    expect(sampler.phases().size).toBe(0)
    const warmed = sampler.warm()
    expect(listed).toBe(1)
    expect(sampler.running).toBe(true)
    release!()
    expect((await warmed).get('t1')).toBe('working')
    sampler.stop()
  })

  it('a listing that fails leaves the last map alone and counts as a completed attempt', async () => {
    let fail = false
    const sampler = createProbeSampler(
      probeDeps({
        listSessionsAsync: async () => {
          if (fail) throw new Error('herdr pane list failed')
          return ['cookrew_t1']
        },
        capturePaneAsync: async () => WORKING_PANE,
        knownTerminalIds: () => ['t1']
      })
    )
    expect((await sampler.sampleAsync()).get('t1')).toBe('working')
    fail = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect((await sampler.sampleAsync()).get('t1')).toBe('working') // not blanked
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    const started = performance.now()
    await sampler.warm()
    expect(performance.now() - started).toBeLessThan(50)
    sampler.stop()
  })

  it('a wedged backend reports a partial pass at the deadline instead of holding the latch', async () => {
    const { PROBE_PASS_DEADLINE_TICKS } = await import('../src/main/board-index')
    let reads = 0
    let clock = 1_800_000_000_000
    const realNow = Date.now
    Date.now = () => clock
    try {
      const sampler = createProbeSampler(
        probeDeps({
          listSessionsAsync: async () => ['cookrew_a', 'cookrew_b', 'cookrew_c'],
          capturePaneAsync: async () => {
            reads += 1
            clock += 10 * PROBE_PASS_DEADLINE_TICKS + 1 // each read overruns the whole deadline
            return WORKING_PANE
          },
          knownTerminalIds: () => ['a', 'b', 'c']
        }),
        10
      )
      const phases = await sampler.sampleAsync()
      expect(reads).toBe(1)
      expect(phases.size).toBe(1)
      expect(sampler.running).toBe(false)
    } finally {
      Date.now = realNow
    }
  })
})

describe('createProbeSampler — review round two', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('warm() does not wait on a running pass once any pass has completed — even with an empty fleet', async () => {
    // The all-attached idle state: the map is legitimately empty forever and
    // the sampler self-parks. A read must not wait on the listing it kicks.
    let listings = 0
    let gate: (() => void) | null = null
    const sampler = createProbeSampler(
      probeDeps({
        listSessionsAsync: () =>
          new Promise<string[]>((resolve) => {
            listings += 1
            if (listings === 1) resolve([])
            else gate = () => resolve([])
          }),
        capturePaneAsync: async () => WORKING_PANE,
        knownTerminalIds: () => ['t1'],
        isAttached: () => true
      }),
      5
    )
    expect((await sampler.sampleAsync()).size).toBe(0) // first pass completed: nothing detached
    await sleep(10) // past the interval, so the next start() kicks a pass
    const started = performance.now()
    const warmed = await sampler.warm()
    expect(performance.now() - started).toBeLessThan(50)
    expect(warmed.size).toBe(0)
    expect(listings).toBe(2) // the read kicked a listing, and did not wait on it
    gate!()
    await sleep(0)
    sampler.stop()
  })

  it('warm() does not wait on a running pass when there is something to show', async () => {
    let gate: (() => void) | null = null
    let passes = 0
    const sampler = createProbeSampler(
      probeDeps({
        listSessionsAsync: async () => ['cookrew_t1'],
        capturePaneAsync: () =>
          new Promise<string>((resolve) => {
            passes += 1
            if (passes === 1) resolve(WORKING_PANE)
            else gate = () => resolve(WAITING_PANE)
          }),
        knownTerminalIds: () => ['t1']
      })
    )
    expect((await sampler.sampleAsync()).get('t1')).toBe('working')
    const second = sampler.sampleAsync() // in flight, held at the read
    await sleep(0)
    // Never-ran is the ONLY state that waits: pinned above ("warm() resolves
    // with the fresh pass"); here a completed pass exists.
    const started = performance.now()
    const warmed = await sampler.warm()
    expect(performance.now() - started).toBeLessThan(50)
    expect(warmed.get('t1')).toBe('working') // the previous pass, not a wait on the running one
    gate!()
    expect((await second).get('t1')).toBe('waiting')
    sampler.stop()
  })

  it('a deadline-truncated pass keeps the previous phase of every terminal it did not reach', async () => {
    const detached = [
      { terminalId: 'a', session: 'cookrew_a' },
      { terminalId: 'b', session: 'cookrew_b' },
      { terminalId: 'c', session: 'cookrew_c' }
    ]
    const previous = new Map<string, 'working' | 'waiting'>([
      ['a', 'working'],
      ['b', 'working'],
      ['c', 'waiting']
    ])
    // a is reached and now idle (no phase); b, c are never reached.
    const merged = mergePartialPass(
      previous,
      { phases: new Map(), reached: 1, heldMs: 0 },
      detached
    )
    expect(merged.has('a')).toBe(false)
    expect(merged.get('b')).toBe('working')
    expect(merged.get('c')).toBe('waiting')
    // A complete pass replaces wholesale.
    const complete = mergePartialPass(previous, { phases: new Map(), reached: 3, heldMs: 0 }, detached)
    expect(complete.size).toBe(0)
  })

  it('reports its main-thread hold as the synchronous segments, never the awaits', async () => {
    const held: number[] = []
    const sampler = createProbeSampler(
      probeDeps({
        listSessionsAsync: async () => ['cookrew_a', 'cookrew_b', 'cookrew_c'],
        capturePaneAsync: () => new Promise<string>((resolve) => setTimeout(() => resolve(WORKING_PANE), 25)),
        knownTerminalIds: () => ['a', 'b', 'c']
      }),
      PROBE_INTERVAL_MS,
      { observe: (ms) => held.push(ms) }
    )
    const started = performance.now()
    await sampler.sampleAsync()
    const wall = performance.now() - started
    expect(wall).toBeGreaterThanOrEqual(70)
    expect(held).toHaveLength(1)
    expect(held[0]).toBeGreaterThanOrEqual(0)
    expect(held[0]).toBeLessThan(wall / 2)
    const pass = await runDetachedPass(
      probeDeps({ capturePaneAsync: async () => WORKING_PANE }),
      [{ terminalId: 'a', session: 'cookrew_a' }]
    )
    expect(pass.reached).toBe(1)
    expect(pass.heldMs).toBeGreaterThanOrEqual(0)
    expect(await probeDetachedAsync(probeDeps({ capturePaneAsync: async () => WORKING_PANE }), [])).toEqual(new Map())
  })
})
