// What a card says about its agent at BOOTSTRAP, and what saying it costs.
//
// Terminals stay detached on a cold start (index.ts: "Herdr keeps their
// processes alive; a settled semantic zoom acquires the local PTY mirror on
// demand"), and turns.list() maps over the TRACKED map — the terminals that
// have a live PtySession. So on a cold boot list() answers [], every card
// falls back to `phase = 'idle'`, and a canvas of hard-working agents paints
// itself entirely READY with green coins. The truth was already in the
// process: herdr's status feed reports working/blocked per pane, and the boot
// loop had it in hand and spent it on file watches.
//
// The cost discipline is the point, so it is pinned rather than described:
// answering "what is every agent doing" must cost ZERO PTY attaches and ZERO
// xterm buffer walks. Attaching mirrors to learn a phase is how a cheap
// question becomes O(terminals × scrollback) — the shape session-drain-cost
// pins for the drain, at the surface a person actually looks at.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import type { TerminalActivity } from '../src/shared/turn'
import { mergeActivity } from '../src/renderer/src/turn-view-model'

class CountingSession extends EventEmitter {
  bufferWalks = 0
  constructor(public terminalId: string) {
    super()
  }
  fullText(): string {
    this.bufferWalks += 1
    return 'output\n'
  }
  viewportText(): string {
    this.bufferWalks += 1
    return 'output\n'
  }
  idleFor(): number {
    return 0
  }
}

function tracker(): TurnTracker {
  return new TurnTracker(async () => null)
}

const listOf = (t: TurnTracker): TerminalActivity[] => t.list()

describe('a cold canvas tells the truth about its agents', () => {
  it('reports the multiplexer phase for a terminal with no mirror at all', () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'thinking')
    expect(turns.phaseOf('t1')).toBe('thinking')
    const listed = listOf(turns)
    expect(listed.map((a) => a.terminalId)).toEqual(['t1'])
    expect(listed[0].phase).toBe('thinking')
    // An honest skeleton: a phase we know, and nothing we do not.
    expect(listed[0].prompt).toBeNull()
    expect(listed[0].reply).toBeNull()
    expect(listed[0].lines).toEqual([])
  })

  it('a blocked agent asks for attention rather than reading as ready', () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'waiting')
    expect(turns.phaseOf('t1')).toBe('waiting')
  })

  it('the LIVE mirror always outranks the backend guess', () => {
    // Once a mirror exists its phase is derived from the real screen; the
    // backend hint must never overwrite it, in either direction.
    const turns = tracker()
    const session = new CountingSession('t1')
    turns.track(session as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'thinking')
    expect(turns.phaseOf('t1')).toBe('idle')
    expect(listOf(turns).filter((a) => a.terminalId === 't1')).toHaveLength(1)
  })

  it('forgetting a terminal forgets its backend phase too', () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'thinking')
    turns.observeBackendPhase('t1', null)
    expect(turns.phaseOf('t1')).toBeUndefined()
    expect(listOf(turns)).toEqual([])
  })

  it('announces a phase change so the card repaints without being asked', () => {
    const turns = tracker()
    const seen: TerminalActivity[] = []
    turns.on('activity', (a: TerminalActivity) => seen.push(a))

    turns.observeBackendPhase('t1', 'thinking')
    turns.observeBackendPhase('t1', 'thinking') // unchanged: silence
    turns.observeBackendPhase('t1', 'waiting')

    expect(seen.map((a) => a.phase)).toEqual(['thinking', 'waiting'])
  })
})

describe('the cost of showing every agent its status', () => {
  it('costs ZERO buffer walks for terminals that have no mirror', () => {
    const turns = tracker()
    const sessions: CountingSession[] = []
    for (let i = 0; i < 5; i += 1) {
      const session = new CountingSession(`m${i}`)
      sessions.push(session)
      turns.track(session as unknown as PtySession, true)
    }
    listOf(turns) // warm: the mirrored five walk their buffers once
    for (const session of sessions) session.bufferWalks = 0

    for (let i = 0; i < 40; i += 1) turns.observeBackendPhase(`t${i}`, 'thinking')
    const listed = listOf(turns)

    expect(listed.filter((a) => a.mirrorless === true)).toHaveLength(40)
    // Forty more agents reported, and not one extra buffer walked: a boot
    // canvas learns 40 phases without opening 40 PTYs.
    const walks = sessions.reduce((sum, s) => sum + s.bufferWalks, 0)
    expect(walks).toBeLessThanOrEqual(sessions.length)
  })

  it('reading every phase stays O(1) per terminal — no activity is built', () => {
    const turns = tracker()
    const sessions: CountingSession[] = []
    for (let i = 0; i < 20; i += 1) {
      const session = new CountingSession(`m${i}`)
      sessions.push(session)
      turns.track(session as unknown as PtySession, true)
      turns.observeBackendPhase(`b${i}`, 'thinking')
    }
    for (const session of sessions) session.bufferWalks = 0

    for (let i = 0; i < 20; i += 1) {
      expect(turns.phaseOf(`m${i}`)).toBe('idle')
      expect(turns.phaseOf(`b${i}`)).toBe('thinking')
    }
    // phaseOf is the scalar path for both kinds — mirrored or not.
    expect(sessions.reduce((sum, s) => sum + s.bufferWalks, 0)).toBe(0)
  })

  it('a mirrored terminal is listed ONCE, never twice', () => {
    const turns = tracker()
    turns.track(new CountingSession('t1') as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'thinking')
    turns.observeBackendPhase('t2', 'waiting')
    const listed = listOf(turns)
    expect(listed.map((a) => a.terminalId).sort()).toEqual(['t1', 't2'])
  })
})

describe('the cost of asking WHERE every agent lives', () => {
  // nodeAcrossWorkspaces sits inside TraceReader.watchSpec, so it is paid
  // once per card per checkpoint poll and once per watch re-arm. It used to
  // read AND JSON.parse every parked workspace.json on each call — a cheap
  // scalar question answered by re-parsing the fleet, synchronously, on the
  // main thread. SHAPE, not milliseconds: the read count is the gate.
  const realRead = fs.readFileSync
  let counting = false
  let reads = 0

  beforeAll(() => {
    fs.readFileSync = ((file: unknown, ...args: unknown[]): unknown => {
      if (counting && typeof file === 'string' && file.endsWith('.json')) reads += 1
      return (realRead as (...a: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.readFileSync
    // Named imports bind at load; store.ts holds its own readFileSync
    // reference. This is what makes the counter reach it (the same move
    // scratchpad/perf-eval-gate.mjs makes for the paste gate).
    syncBuiltinESMExports()
  })
  afterAll(() => {
    fs.readFileSync = realRead
    syncBuiltinESMExports()
  })

  it('re-asks a parked workspace only when its file actually changed', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'boot-status-store-'))
    const writer = new WorkspaceStore(base)
    const parked = writer.createWorkspace('Parked', base)
    writer.switchWorkspace(parked.id)
    writer.addNode({
      kind: 'terminal',
      id: 'far-1',
      name: 'Far',
      preset: 'Claude Code',
      command: 'claude',
      cwd: base,
      orch: false,
      role: null,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 }
    } as never)
    const focused = writer.createWorkspace('Focused', base)
    writer.switchWorkspace(focused.id) // switching EVICTS the one you left
    writer.flush()

    // A fresh store holds only its focused workspace: far-1 lives on disk,
    // in a workspace nothing has hydrated — the shape watchSpec meets on a
    // canvas whose agents span workspaces.
    const store = new WorkspaceStore(base)
    counting = true
    reads = 0
    const first = store.nodeAcrossWorkspaces('far-1')
    const cold = reads
    for (let i = 0; i < 20; i += 1) store.nodeAcrossWorkspaces('far-1')
    const warm = reads - cold
    counting = false

    expect(first?.node.id).toBe('far-1')
    // Twenty more polls cost nothing: the stamp is a stat, not a read.
    // Before the memo each poll re-read AND re-parsed every parked file.
    expect(warm).toBe(0)
    expect(store.nodeAcrossWorkspaces('far-1')?.workspaceId).toBe(first?.workspaceId)
  })

  it('a changed file is re-read — the memo is a stamp, never a snapshot', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'boot-status-stamp-'))
    const writer = new WorkspaceStore(base)
    const parked = writer.createWorkspace('Parked', base)
    writer.switchWorkspace(parked.id)
    writer.addNode({
      kind: 'terminal',
      id: 'far-1',
      name: 'Far',
      preset: 'Claude Code',
      command: 'claude',
      cwd: base,
      orch: false,
      role: null,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 }
    } as never)
    const focused = writer.createWorkspace('Focused', base)
    writer.switchWorkspace(focused.id)
    writer.flush()

    const store = new WorkspaceStore(base)
    expect(store.nodeAcrossWorkspaces('far-1')?.node.name).toBe('Far')

    // Another instance renames it underneath us. A snapshot would lie here.
    const other = new WorkspaceStore(base)
    other.switchWorkspace(parked.id)
    other.updateNode('far-1', { name: 'Renamed' })
    other.flush()

    expect(store.nodeAcrossWorkspaces('far-1')?.node.name).toBe('Renamed')
  })
})

describe('a guess never poses as a fact', () => {
  it('marks the skeleton, and leaves a real activity unmarked', () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'thinking')
    turns.track(new CountingSession('t2') as unknown as PtySession, true)
    const byId = new Map(listOf(turns).map((a) => [a.terminalId, a]))
    expect(byId.get('t1')?.mirrorless).toBe(true)
    expect(byId.get('t2')?.mirrorless).toBeUndefined()
    // listVerified is what every caller needing a VERIFIED fact reads.
    expect(turns.listVerified().map((a) => a.terminalId)).toEqual(['t2'])
  })

  it('a shell is not made into an agent by a herdr status', () => {
    const turns = tracker()
    turns.observeBackendPhase('sh', 'thinking', false)
    expect(listOf(turns)[0].agent).toBe(false)
  })

  it('retracts on silence — a stuck WORKING is the failure this must not have', () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'thinking')
    turns.observeBackendPhase('t1', null)
    expect(turns.phaseOf('t1')).toBeUndefined()
    expect(listOf(turns)).toEqual([])
  })

  it('reports the observation time, not the moment it was asked', async () => {
    const turns = tracker()
    turns.observeBackendPhase('t1', 'thinking')
    const first = listOf(turns)[0].updatedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(listOf(turns)[0].updatedAt).toBe(first)
  })
})

describe('a phase-only update never blanks a card', () => {
  it('keeps the words it does not know, and takes the phase it does', () => {
    const rich: TerminalActivity = {
      terminalId: 't1',
      agent: true,
      phase: 'replied',
      prompt: 'the ask',
      pendingInput: null,
      lines: ['a line'],
      reply: 'the reply',
      glance: null,
      title: 'a title',
      turnCount: 3,
      turnStartedAt: null,
      turnStartLine: null,
      scrollRow: null,
      scrollBase: null,
      tailLines: null,
      dispatchId: null,
      updatedAt: 10
    }
    const skeleton: TerminalActivity = {
      ...rich,
      mirrorless: true,
      phase: 'thinking',
      prompt: null,
      lines: [],
      reply: null,
      title: null,
      updatedAt: 20
    }
    const merged = mergeActivity(rich, skeleton)
    expect(merged.phase).toBe('thinking')
    expect(merged.prompt).toBe('the ask')
    expect(merged.reply).toBe('the reply')
    expect(merged.title).toBe('a title')
    expect(merged.updatedAt).toBe(20)

    // A real activity replaces whole — it saw the screen.
    expect(mergeActivity(rich, { ...rich, phase: 'idle', reply: null })).toMatchObject({
      phase: 'idle',
      reply: null
    })
    // With nothing known yet, the skeleton IS the card's first news.
    expect(mergeActivity(undefined, skeleton)).toBe(skeleton)
  })
})
