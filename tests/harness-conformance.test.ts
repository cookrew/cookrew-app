// PERMANENT harness-integration gate (harness-integration-contract): adding a
// new agent harness is ONE entry in the registry, and that entry must
// consciously declare its turn-history capability. A 'file' harness without a
// working parser — or a parser whose indices drift from the trace blocks the
// checkpoint rail reads — fails this suite. Do not weaken these assertions to
// land a new harness; implement the capability instead.

import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HARNESSES, harnessFor } from '../src/main/harness'
import { SessionTurnSync } from '../src/main/session-sync'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import { parseClaudeTrace, parseCodexTrace, parsePiTrace } from '../src/shared/trace-blocks'
import { parseSessionTurns } from '../src/shared/session-turns'

describe('harness registry conformance', () => {
  it('every harness declares a turn-history capability', () => {
    for (const harness of HARNESSES) {
      expect(['file', 'scrape'], `${harness.id} must declare turns: 'file' | 'scrape'`).toContain(
        harness.turns
      )
    }
  })

  it("'file' capability ⇔ parser AND watch-file resolver wired, never partial", () => {
    for (const harness of HARNESSES) {
      if (harness.turns === 'file') {
        expect(typeof harness.parseTurns, `${harness.id} declares 'file' but has no parser`).toBe('function')
        expect(typeof harness.watchFile, `${harness.id} declares 'file' but has no watchFile`).toBe('function')
      } else {
        expect(harness.parseTurns, `${harness.id} declares 'scrape' but wires a parser`).toBeUndefined()
        expect(harness.watchFile, `${harness.id} declares 'scrape' but wires a watchFile`).toBeUndefined()
      }
    }
  })

  it('claude, codex and pi all carry file-derived history (the general-agent baseline)', () => {
    const byId = new Map(HARNESSES.map((h) => [h.id, h]))
    for (const id of ['claude', 'codex', 'pi'] as const) {
      expect(byId.get(id)?.turns, `${id} lost file-derived turn history`).toBe('file')
    }
  })

  it('every harness validates its resume key before it can reach a shell command', () => {
    const byId = new Map(HARNESSES.map((h) => [h.id, h]))
    // Closed alphabets reject traversal/metacharacters outright.
    expect(byId.get('pi')!.resumeKey('../../etc/passwd')).toBeNull()
    expect(byId.get('pi')!.resumeKey('x; rm -rf /')).toBeNull()
    expect(byId.get('opencode')!.resumeKey('../../etc/passwd')).toBeNull()
    expect(byId.get('codex')!.resumeKey('not-a-uuid; echo hi')).toBeNull()
    // Claude's pass-through key is guarded upstream (resolveClaudeSessionId
    // drops invalid ids before they reach paths/commands) — pin that the
    // resolver-facing contract at least rejects empties.
    expect(byId.get('claude')!.resumeKey('')).toBeNull()
  })
})

describe('turn/trace identity alignment (phantom-offset gate)', () => {
  // One identity space: TurnRecord.index (card pager, titles) MUST equal
  // TraceBlock.index (checkpoint rail, rewind picker) on the same session
  // lines, for every 'file' harness.
  const T0 = Date.parse('2026-08-05T10:00:00.000Z')

  const claudeLines = [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' }, timestamp: new Date(T0).toISOString() }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] }, timestamp: new Date(T0 + 1000).toISOString() }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'two' }, timestamp: new Date(T0 + 2000).toISOString() })
  ]
  const codexLines = [
    JSON.stringify({ timestamp: new Date(T0).toISOString(), type: 'session_meta', payload: { session_id: 's', timestamp: new Date(T0).toISOString(), cwd: '/w' } }),
    JSON.stringify({ timestamp: new Date(T0 + 1000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'one' } }),
    JSON.stringify({ timestamp: new Date(T0 + 2000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'two' } })
  ]
  const piLines = [
    JSON.stringify({ type: 'session', id: 's', cwd: '/w' }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'one', timestamp: T0 } }),
    JSON.stringify({ type: 'message', id: 'u2', parentId: 'u1', message: { role: 'user', content: 'two', timestamp: T0 + 1000 } })
  ]

  const cases: Array<{ id: string; lines: string[]; trace: (l: string[]) => { index: number }[] }> = [
    { id: 'claude', lines: claudeLines, trace: parseClaudeTrace },
    { id: 'codex', lines: codexLines, trace: parseCodexTrace },
    { id: 'pi', lines: piLines, trace: parsePiTrace }
  ]

  for (const { id, lines, trace } of cases) {
    it(`${id}: turn indices === trace block indices`, () => {
      const harness = HARNESSES.find((h) => h.id === id)
      expect(harness?.parseTurns).toBeTypeOf('function')
      const turns = harness!.parseTurns!(lines)
      expect(turns.map((t) => t.index)).toEqual(trace(lines).map((b) => b.index))
      expect(turns.length).toBeGreaterThan(0)
    })
  }

  it('claude parser stays the shared session-turns implementation', () => {
    const harness = HARNESSES.find((h) => h.id === 'claude')
    expect(harness?.parseTurns).toBe(parseSessionTurns)
  })
})

// REFACTOR STEP 5 (checkpoint-as-identity): fence the exception.
//
// Step 4 made the session file the durable record for turns: 'file'. That
// leaves two populations that will never have a session file — turns: 'scrape'
// harnesses (opencode today) and plain shells with no harness at all — for
// which the PTY scrape is the ONLY history there will ever be. It also leaves
// a window: a 'file' harness between spawn and its first session-file write.
//
// The invariant these tests pin is one sentence: AT EVERY INSTANT, SOMETHING
// IS RECORDING. An agent that silently stops minting checkpoints is the worst
// failure this codebase has, because nothing surfaces it until someone goes
// looking for a turn that is gone. Do not relax these to land a change.

/** Minimal PtySession stand-in (mirrors tests/turn-tracker.test.ts). */
class FakeSession extends EventEmitter {
  constructor(public terminalId: string) {
    super()
  }
  full = ''
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

/** Drive one complete scraped turn and report what history it produced. */
async function recordOneTurn(
  tracker: TurnTracker,
  session: FakeSession,
  prompt = 'do the thing'
): Promise<number> {
  session.emit('input', `${prompt}\r`)
  session.full = '⏺ done, all tests pass'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
  return tracker.history(session.terminalId).length
}

describe('scrape-only harnesses keep their history (the fenced exception)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the exception list is exactly the harnesses that declare it', () => {
    const scrape = HARNESSES.filter((h) => h.turns === 'scrape').map((h) => h.id).sort()
    // Adding a harness to this list means accepting that it can never show a
    // checkpoint rail, a rewind or a trace. Make that a deliberate edit.
    expect(scrape).toEqual(['opencode'])
  })

  it('opencode: a completed turn is recorded by the tracker, with no session file', async () => {
    vi.useFakeTimers()
    const harness = harnessFor('opencode')
    expect(harness?.turns).toBe('scrape')
    // Nothing can hand this terminal off: there is no parser and no file.
    expect(harness?.parseTurns).toBeUndefined()

    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession('opencode-1')
    tracker.track(session as unknown as PtySession, true)
    expect(await recordOneTurn(tracker, session)).toBe(1)
    tracker.disposeAll()
  })

  it('a plain shell has no harness at all and still falls on the scrape path', async () => {
    vi.useFakeTimers()
    expect(harnessFor('bash -l')).toBeNull()
    expect(harnessFor('/bin/zsh')).toBeNull()

    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession('shell-1')
    // Tracked as an agent (a shell running an unknown agent CLI) — no harness
    // means no session sync, so the scrape must still record.
    tracker.track(session as unknown as PtySession, true)
    expect(await recordOneTurn(tracker, session)).toBe(1)
    tracker.disposeAll()
  })
})

describe('file harnesses: the boot window is never a recording gap', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const FIXTURES: Record<string, string[]> = {
    claude: [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'one' },
        timestamp: new Date(Date.parse('2026-08-05T10:00:00.000Z')).toISOString()
      })
    ],
    codex: [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 's', cwd: '/w' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'one' } })
    ],
    pi: [
      JSON.stringify({
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'one', timestamp: 1 }
      })
    ]
  }

  for (const harness of HARNESSES.filter((h) => h.turns === 'file')) {
    it(`${harness.id}: scrapes before the session file exists, hands over after`, async () => {
      vi.useFakeTimers()
      const dir = mkdtempSync(path.join(tmpdir(), `cookrew-${harness.id}-`))
      const file = path.join(dir, 'session.jsonl')
      const tracker = new TurnTracker(async () => null, null)
      const session = new FakeSession(`${harness.id}-1`)
      tracker.track(session as unknown as PtySession, true)
      const sync = new SessionTurnSync(tracker, 50)

      // Spawn: watching a file the harness has not written yet.
      sync.watch(session.terminalId, file, harness.parseTurns!)
      // THE GAP TEST. If this is 0, turns taken during boot are lost forever.
      expect(await recordOneTurn(tracker, session, 'boot-window ask')).toBe(1)

      // The harness writes its session file; the reconcile takes over.
      writeFileSync(file, FIXTURES[harness.id].join('\n') + '\n', 'utf8')
      await vi.advanceTimersByTimeAsync(200)
      const reconciled = tracker.history(session.terminalId)
      expect(reconciled.length).toBeGreaterThan(0)
      expect(reconciled.every((r) => r.prompt !== 'boot-window ask')).toBe(true)

      // From here the file is the sole writer — a second turn adds no record.
      const after = await recordOneTurn(tracker, session, 'post-handover ask')
      expect(after).toBe(reconciled.length)

      sync.dispose()
      tracker.disposeAll()
    })
  }

  it('a parser that throws on the real file leaves the terminal scraping', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-badparse-'))
    const file = path.join(dir, 'session.jsonl')
    writeFileSync(file, 'anything\n', 'utf8')
    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession('broken-1')
    tracker.track(session as unknown as PtySession, true)
    const sync = new SessionTurnSync(tracker, 50)

    // A miswired 'file' harness. It must not be able to switch the scrape off
    // and leave the terminal with no writer at all.
    sync.watch(session.terminalId, file, () => {
      throw new Error('parser does not understand this format')
    })
    expect(await recordOneTurn(tracker, session)).toBe(1)

    sync.dispose()
    tracker.disposeAll()
  })

  it('a rebind to a not-yet-written session file reopens the scrape', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-rebind-'))
    const first = path.join(dir, 'first.jsonl')
    writeFileSync(first, FIXTURES.claude.join('\n') + '\n', 'utf8')
    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession('rebind-1')
    tracker.track(session as unknown as PtySession, true)
    const sync = new SessionTurnSync(tracker, 50)

    sync.watch(session.terminalId, first, parseSessionTurns)
    const handedOver = tracker.history(session.terminalId).length
    expect(handedOver).toBeGreaterThan(0)

    // Restore/rewind: the node now points at a truncated copy that the CLI has
    // not recreated yet. Turns taken in that window must still be recorded.
    sync.watch(session.terminalId, path.join(dir, 'restored.jsonl'), parseSessionTurns)
    expect(await recordOneTurn(tracker, session, 'mid-rebind ask')).toBe(handedOver + 1)

    sync.dispose()
    tracker.disposeAll()
  })
})
