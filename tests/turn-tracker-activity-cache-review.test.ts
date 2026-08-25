// Review PoCs for the task #14 activity cache (39a8b7f).
//
// Reviewed as the CONSUMER: step 3 serves /api/state per slug, so this cache
// sits under N phones polling N workspaces, and a stale tail there is a stale
// tail on someone's phone.
//
// The fix's own bargain is the right one — cache only what costs a buffer walk,
// gate it on an output revision, leave the cheap scalars live. What these tests
// show is that the revision does not move on every input that changes the
// buffer, and that the arm the commit measures is not the arm its tests
// exercise.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

/**
 * A session whose buffer can change the way a REAL one does — by output, and
 * also by reflow. PtySession.resize() calls screen.resize(), which rewraps the
 * xterm buffer and changes both viewportText() (its window is
 * `buffer.length - rows`) and fullText(); it then emits 'replay', NOT 'data'.
 */
class ReflowSession extends EventEmitter {
  terminalId = 'term-1'
  full = 'boot\n'
  fullTextCalls = 0
  viewportCalls = 0
  idle = 0

  fullText(): string {
    this.fullTextCalls += 1
    return this.full
  }
  viewportText(): string {
    this.viewportCalls += 1
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
  /** Output arrives the way the real PTY delivers it: write, then 'data'. */
  emitOutput(chunk: string): void {
    this.full += chunk
    this.emit('data', chunk)
  }
  /**
   * A geometry change, the way PtySession.resize does it: the buffer content
   * changes (rewrap) and 'replay' is emitted. No 'data'.
   */
  reflow(next: string): void {
    this.full = next
    this.emit('replay', next)
  }
  /**
   * A TUI repainting IN PLACE — the case the commit measures the spaced arm
   * on. The buffer is REPLACED, not appended to, which is exactly why
   * diffOutput's `startsWith` fast path fails there.
   */
  repaint(next: string): void {
    this.full = next
    this.emit('data', next)
  }
}

function fixture(): { tracker: TurnTracker; session: ReflowSession } {
  const tracker = new TurnTracker(async () => null, null)
  const session = new ReflowSession()
  tracker.track(session as unknown as PtySession, { agent: true } as never)
  return { tracker, session }
}

// INVERTED, deliberately. Atlas wrote these two to document the defect and
// they PASSED against the first cut of the cache; they now assert the fixed
// contract. The defect they proved: a resize rewraps the mirror and emits
// 'replay', not 'data', so outputRev stood still while fullText() and
// viewportText()'s `buffer.length - screen.rows` window both changed. On a
// quiet pane nothing arrives to correct it, so it was stale indefinitely —
// not "bounded to a tail" as the commit claimed.
describe('H1 — a reflow re-derives, because the key names geometry too', () => {
  it('serves the POST-resize tail after a geometry change', () => {
    // Reachable from mobile-api /api/terminal/:id/resize (a phone rotating)
    // and from the desktop's own resize IPC. On a QUIET pane — precisely the
    // case this cache exists to serve — no output follows to correct it, so
    // the stale tail is not bounded by the next chunk. It is indefinite.
    const { tracker, session } = fixture()
    session.emitOutput('line one is quite long and will rewrap\n')
    const before = tracker.list()[0]

    session.reflow('line one is quite\nlong and will rewrap\n')
    const after = tracker.list()[0]

    // The reflowed buffer is visibly different, and so is the served tail.
    expect(after.lines).not.toEqual(before.lines)
    expect(after.lines.join('\n')).toContain('line one is quite')
    expect(after.lines.join('\n')).toContain('long and will rewrap')
  })

  it('re-walks the buffer after a reflow', () => {
    const { tracker, session } = fixture()
    tracker.list()
    session.reflow('completely different content after rewrap\n')

    session.fullTextCalls = 0
    session.viewportCalls = 0
    tracker.list()

    // Non-zero: geometry is in the key, so the reflow invalidates it.
    expect(session.fullTextCalls + session.viewportCalls).toBeGreaterThan(0)
  })

  it('and a byte of output after a reflow is still served', () => {
    // Kept from Atlas's PoC: it was the bound that DID exist (a busy pane
    // self-corrects), and it must keep holding now the quiet pane does too.
    const { tracker, session } = fixture()
    tracker.list()
    session.reflow('rewrapped\n')
    session.emitOutput('x\n')
    const after = tracker.list()[0]
    expect(after.lines.join('\n')).toContain('rewrapped')
  })
})

describe('H2 — the repaint arm is measured but not asserted', () => {
  it('a TUI repaint in place is served fresh', () => {
    // The commit measures the spaced arm at 233ms -> 16.1ms and says it is
    // "asserted fresh, not stale". The shipped fixture only ever APPENDS
    // (`this.full += chunk`), so no test in it can express a repaint — which
    // is the whole reason that arm was expensive (`startsWith` fails, the
    // ~500KB string is split twice). This is that assertion.
    const { tracker, session } = fixture()
    session.emitOutput('first frame of the TUI\n')
    tracker.list()

    session.repaint('SECOND frame, painted over the first\n')
    const after = tracker.list()[0]

    expect(after.lines.join('\n')).toContain('SECOND frame')
    expect(after.lines.join('\n')).not.toContain('first frame')
  })

  it('a repaint that SHRINKS the buffer is served fresh', () => {
    // The adversarial direction: a repaint that makes the buffer shorter
    // cannot be caught by any length or append heuristic.
    const { tracker, session } = fixture()
    session.emitOutput('aaaa\nbbbb\ncccc\ndddd\n')
    tracker.list()

    session.repaint('short\n')
    const after = tracker.list()[0]

    expect(after.lines.join('\n')).toContain('short')
    expect(after.lines.join('\n')).not.toContain('dddd')
  })
})

describe('budget — what the cache actually buys', () => {
  it('a quiet pane costs nothing per read (the 4.7s case, fixed)', () => {
    const { tracker, session } = fixture()
    tracker.list()
    for (let i = 0; i < 5; i += 1) {
      session.fullTextCalls = 0
      session.viewportCalls = 0
      tracker.list()
      expect(session.fullTextCalls + session.viewportCalls).toBe(0)
    }
  })

  it('a STREAMING pane pays the full walk on every read, as before', () => {
    // The honest budget line, and the one that matters for step 3: the cache
    // is invalidated per CHUNK, not per burst. While output is arriving every
    // read recomputes, so the cost is unchanged from before the fix — and
    // under slugs the number of readers goes UP, not down.
    const { tracker, session } = fixture()
    let walks = 0
    for (let i = 0; i < 5; i += 1) {
      session.emitOutput(`chunk ${i}\n`)
      session.fullTextCalls = 0
      session.viewportCalls = 0
      tracker.list()
      walks += session.fullTextCalls + session.viewportCalls
    }
    expect(walks).toBeGreaterThanOrEqual(5)
  })

  it('two readers of the same terminal share one walk', () => {
    // The half that DOES help step 3: N phones polling N slugs still walk each
    // terminal at most once per chunk, because the cache is per terminal and
    // not per request.
    const { tracker, session } = fixture()
    session.emitOutput('fresh\n')
    session.fullTextCalls = 0
    session.viewportCalls = 0

    tracker.list() // reader A
    const afterA = session.fullTextCalls + session.viewportCalls
    tracker.list() // reader B, same tick
    const afterB = session.fullTextCalls + session.viewportCalls

    expect(afterA).toBeGreaterThan(0)
    expect(afterB).toBe(afterA)
  })
})
