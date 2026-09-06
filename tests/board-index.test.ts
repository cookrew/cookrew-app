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
import { ScrapeHistoryStore } from '../src/main/scrape-history'
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
      turns: { listVerified: () => [] },
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
      turns: { listVerified: () => [] },
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
          listVerified: (): TerminalActivity[] => {
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

  /**
   * T4 turned the loadAll cache from write-through to STAT-VALIDATED. The old
   * contract was "a file written behind its back is NOT re-read", which was
   * sound while this process was the only writer of ~/.cookrew/turns. It is
   * not any more (scrape-history.ts), so the cache re-reads exactly the
   * entries whose file has moved — a stat each, not a parse.
   */
  it('re-reads only the entries whose file moved', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.jsonl'), `${JSON.stringify(record({ index: 1 }))}\n`, 'utf8')
    const store = new TurnStore(dir)
    expect(store.loadAll().size).toBe(1)
    const first = store.loadAll().get('a')
    // Unmoved: the very same array, straight out of the cache.
    expect(store.loadAll().get('a')).toBe(first)

    writeFileSync(
      path.join(dir, 'a.jsonl'),
      `${JSON.stringify(record({ index: 1 }))}\n${JSON.stringify(record({ index: 2 }))}\n`,
      'utf8'
    )
    expect(store.loadAll().get('a')).toHaveLength(2)
  })

  it('sees a ledger the one remaining writer just extended', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    const store = new TurnStore(dir)
    const writer = new ScrapeHistoryStore(dir, store.annotationsDir, new TurnStore(dir))
    expect(store.loadAll().size).toBe(0)
    writer.save('t1', [record({ index: 1 })])
    expect(store.loadAll().get('t1')).toHaveLength(1)
    writer.save('t1', [record({ index: 1 }), record({ index: 2 })])
    expect(store.loadAll().get('t1')).toHaveLength(2)
  })

  it('drops a removed terminal', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'turns-')), 'turns')
    const store = new TurnStore(dir)
    new ScrapeHistoryStore(dir, store.annotationsDir, new TurnStore(dir)).save('gone', [
      record({ index: 1 })
    ])
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

  it('re-samples on the ladder while subscribed, and climbs it while nothing changes', () => {
    vi.useFakeTimers()
    try {
      let scans = 0
      const sampler = createProbeSampler(
        probeDeps({
          listSessions: () => {
            scans += 1
            return ['cookrew_t1']
          },
          knownTerminalIds: () => ['t1'],
          capturePane: () => WORKING_PANE
        }),
        PROBE_INTERVAL_MS,
        { backoffMs: [100, 300, 1000] }
      )
      const release = sampler.subscribe()
      expect(scans).toBe(1) // the first pass: empty → working, a change → first rung
      expect(sampler.stats().intervalMs).toBe(100)
      vi.advanceTimersByTime(100)
      expect(scans).toBe(2) // unchanged → second rung
      expect(sampler.stats().intervalMs).toBe(300)
      vi.advanceTimersByTime(299)
      expect(scans).toBe(2)
      vi.advanceTimersByTime(1)
      expect(scans).toBe(3) // unchanged → top rung, and it stays there
      expect(sampler.stats().intervalMs).toBe(1000)
      vi.advanceTimersByTime(3000)
      expect(scans).toBe(6)
      expect(sampler.stats().intervalMs).toBe(1000)
      release()
      vi.advanceTimersByTime(10_000)
      expect(scans).toBe(6) // nobody is looking: nothing runs
    } finally {
      vi.useRealTimers()
    }
  })

  it('lives exactly as long as its subscribers — not as long as anything is detached', () => {
    vi.useFakeTimers()
    try {
      const sampler = createProbeSampler(
        probeDeps({ listSessions: () => ['cookrew_t1'], knownTerminalIds: () => ['t1'], capturePane: () => WORKING_PANE })
      )
      expect(sampler.running).toBe(false)
      const a = sampler.subscribe()
      const b = sampler.subscribe()
      expect(sampler.running).toBe(true)
      expect(sampler.stats().subscribers).toBe(2)
      a()
      a() // a double release is one release
      expect(sampler.running).toBe(true)
      b()
      expect(sampler.running).toBe(false) // with the pane still detached
      expect(sampler.stats().subscribers).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a one-shot touch runs at most one pass and never the timer', () => {
    vi.useFakeTimers()
    try {
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
      sampler.touch()
      sampler.touch()
      sampler.touch()
      expect(scans).toBe(1) // within the first rung: one pass serves every read
      expect(sampler.running).toBe(false)
      vi.advanceTimersByTime(PROBE_INTERVAL_MS * 20)
      expect(scans).toBe(1) // nothing ticks on its own
      sampler.touch()
      expect(scans).toBe(2) // stale again: one more pass, still no timer
      expect(sampler.running).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
  it('lists the panes exactly once per pass, on the ladder', () => {
    vi.useFakeTimers()
    try {
      let listed = 0
      let passes = 0
      const sampler = createProbeSampler(
        probeDeps({
          listSessions: () => {
            listed += 1
            return ['cookrew_t1']
          },
          knownTerminalIds: () => ['t1'],
          capturePane: () => WORKING_PANE
        }),
        PROBE_INTERVAL_MS,
        { observe: () => void (passes += 1), backoffMs: [PROBE_INTERVAL_MS, PROBE_INTERVAL_MS, PROBE_INTERVAL_MS] }
      )
      sampler.start()
      expect(listed).toBe(1)
      vi.advanceTimersByTime(PROBE_INTERVAL_MS * 3)
      expect(passes).toBe(4)
      expect(listed).toBe(4)
      expect(sampler.running).toBe(true)
      sampler.stop()
    } finally {
      vi.useRealTimers()
    }
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

  it('keeps ticking on the ladder while subscribed even when nothing is detached, without the sync reads', async () => {
    vi.useFakeTimers()
    try {
      const { deps, calls } = asyncDeps({ listSessionsAsync: async () => [] })
      const sampler = createProbeSampler(deps, PROBE_INTERVAL_MS, { backoffMs: [100, 200] })
      const release = sampler.subscribe()
      await vi.advanceTimersByTimeAsync(100)
      expect(sampler.running).toBe(true)
      expect(calls.listSync).toBe(0)
      release()
      expect(sampler.running).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
    expect(sampler.running).toBe(false) // a read never starts the timer
    release!()
    expect((await warmed).get('t1')).toBe('working')
    sampler.stop()
  })

  it('a failed pass bills only its synchronous segments, never the wait it was interrupted in', async () => {
    const held: number[] = []
    const failAfter = (ms: number): Promise<string[]> =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('herdr pane list failed')), ms))
    const sampler = createProbeSampler(
      probeDeps({ listSessionsAsync: () => failAfter(120), knownTerminalIds: () => ['t1'] }),
      PROBE_INTERVAL_MS,
      { observe: (ms) => held.push(ms) }
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const started = performance.now()
      await sampler.sampleAsync()
      expect(performance.now() - started).toBeGreaterThanOrEqual(100) // the wait happened
      expect(held).toHaveLength(1)
      expect(held[0]).toBeLessThan(10) // but the probe held the thread for single-digit ms
    } finally {
      spy.mockRestore()
    }
    // The same for a read that fails mid-pass.
    const held2: number[] = []
    const sampler2 = createProbeSampler(
      probeDeps({
        listSessionsAsync: async () => ['cookrew_t1'],
        capturePaneAsync: () => new Promise((_r, reject) => setTimeout(() => reject(new Error('read failed')), 120)),
        knownTerminalIds: () => ['t1']
      }),
      PROBE_INTERVAL_MS,
      { observe: (ms) => held2.push(ms) }
    )
    const spy2 = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await sampler2.sampleAsync()
      expect(held2[0]).toBeLessThan(10)
    } finally {
      spy2.mockRestore()
    }
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

describe('createProbeSampler — events first, the tick as fallback', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const fleet = () => {
    let listings = 0
    let reads = 0
    const status = new Map<string, 'working' | 'blocked' | 'idle' | 'done' | null>([
      ['pushed', 'idle'],
      ['pixels', null]
    ])
    const attached = new Set<string>()
    const pane = new Map<string, string>([['cookrew_pixels', IDLE_PANE]])
    const deps = probeDeps({
      listSessionsAsync: async () => {
        listings += 1
        return ['cookrew_pushed', 'cookrew_pixels']
      },
      capturePaneAsync: async (session) => {
        reads += 1
        return pane.get(session) ?? ''
      },
      knownTerminalIds: () => ['pushed', 'pixels', 'nopane'],
      isAttached: (id) => attached.has(id),
      askedStatus: (id) => status.get(id) ?? null
    })
    const sampler = createProbeSampler(deps, PROBE_INTERVAL_MS, { backoffMs: [50, 200] })
    return { sampler, status, attached, pane, listings: () => listings, reads: () => reads }
  }

  it('a herdr status push recomputes one terminal with no listing and fires change', async () => {
    const { sampler, status, listings } = fleet()
    await sampler.sampleAsync()
    expect(sampler.phases().has('pushed')).toBe(false) // idle: nothing to say
    const changes: number[] = []
    const off = sampler.onChange((phases) => changes.push(phases.size))
    status.set('pushed', 'working')
    const started = performance.now()
    await sampler.invalidate('pushed')
    expect(performance.now() - started).toBeLessThan(50)
    expect(sampler.phases().get('pushed')).toBe('working')
    expect(changes).toEqual([1])
    expect(listings()).toBe(1) // the pass's; the event listed nothing
    status.set('pushed', 'blocked')
    await sampler.invalidate('pushed')
    expect(sampler.phases().get('pushed')).toBe('waiting')
    await sampler.invalidate('pushed') // the same fact again: no change, no event
    expect(changes).toEqual([1, 1])
    off()
    expect(sampler.stats().invalidationsLastMinute).toBe(3)
  })

  it('a pixel-only pane is re-read alone; an attached pane leaves the map; an unlisted pane waits for the pass', async () => {
    const { sampler, attached, pane, reads, listings } = fleet()
    await sampler.sampleAsync()
    expect(reads()).toBe(1)
    pane.set('cookrew_pixels', WORKING_PANE)
    await sampler.invalidate('pixels')
    expect(reads()).toBe(2) // one read, this pane only
    expect(sampler.phases().get('pixels')).toBe('working')
    attached.add('pixels')
    await sampler.invalidate('pixels')
    expect(sampler.phases().has('pixels')).toBe(false) // L1 owns it now
    expect(reads()).toBe(2)
    await sampler.invalidate('nopane') // never listed: nothing to read, nothing to say
    expect(reads()).toBe(2)
    expect(listings()).toBe(1)
  })

  it('an event drops the ladder back to the first rung', async () => {
    const { sampler, listings } = fleet()
    const release = sampler.subscribe()
    await sleep(5)
    await sleep(60) // rung 0 fires (unchanged → rung 1 = 200 ms)
    expect(sampler.stats().intervalMs).toBe(200)
    await sampler.invalidate('pushed')
    expect(sampler.stats().intervalMs).toBe(50)
    const before = listings()
    await sleep(70)
    expect(listings()).toBeGreaterThan(before) // the next pass came at the first rung, not at 200 ms
    release()
  })

  it('stats say what the sampler did in the last minute', async () => {
    const { sampler } = fleet()
    expect(sampler.stats()).toEqual({
      subscribers: 0,
      intervalMs: 50,
      passesLastMinute: 0,
      listingsLastMinute: 0,
      invalidationsLastMinute: 0,
      everCompleted: false,
      running: false
    })
    await sampler.sampleAsync()
    const s = sampler.stats()
    expect([s.passesLastMinute, s.listingsLastMinute, s.everCompleted]).toEqual([1, 1, true])
  })
})
