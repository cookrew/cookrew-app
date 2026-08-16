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
  hasDetachedSessions,
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
      store: { activeId: 'ws-1' },
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
      store: { activeId: 'ws' },
      turns: { list: () => [] },
      turnStore: { loadAll: () => new Map() },
      agents: { list: () => [] }
    })
    expect(built.probe).toBeUndefined()
  })

  it('reads each layer lazily, so a snapshot always sees current state', () => {
    let calls = 0
    const built = boardSourcesFrom({
      store: { activeId: 'ws' },
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

describe('hasDetachedSessions', () => {
  it('is true only when a known terminal has a session but no pty', () => {
    const base = { listSessions: () => ['cookrew_t1'], knownTerminalIds: () => ['t1'] }
    expect(hasDetachedSessions(probeDeps(base))).toBe(true)
    expect(hasDetachedSessions(probeDeps({ ...base, isAttached: () => true }))).toBe(false)
    expect(hasDetachedSessions(probeDeps({ ...base, listSessions: () => [] }))).toBe(false)
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
