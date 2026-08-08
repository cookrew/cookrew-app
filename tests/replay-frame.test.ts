// The attach/reattach baseline, and why it had to stop being plain text.
//
// Under tmux the old baseline — `viewportText()`, escapes stripped — was
// survivable: tmux fully repaints on every attach and resize, so a viewer that
// started from an approximation was corrected within a frame. herdr does not.
// Its chrome-off client optimizes to dirty-region repaints with ABSOLUTE
// cursor addressing bound to the pane geometry (measured: 0 idle bytes), so a
// viewer seeded with unstyled, unwrapped text at a different width applies
// those addresses to the wrong cells — doubled line spacing, blocks out of
// order, the scrambled transcripts reported only ever in herdr mode.
//
// The fix is a FAITHFUL frame at a DECLARED geometry, so these tests are about
// exactly those two things: does the frame reproduce the mirror, and does it
// say what size it was serialized at.

import { describe, expect, it } from 'vitest'
import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { buildReplayFrame, modeReplay, planWheelJump, CLEAR_SCREEN } from '../src/main/pty'
import type { Terminal as HeadlessTerminalType } from '@xterm/headless'

const { Terminal } = xtermHeadless as unknown as { Terminal: typeof HeadlessTerminalType }

/** A mirror with the serialize addon loaded, exactly as PtySession builds it. */
function mirror(cols = 40, rows = 10): { screen: HeadlessTerminalType; frame: () => string } {
  const screen = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  return { screen, frame: () => buildReplayFrame(screen, serializer) }
}

/** Write and let xterm's parser drain — it processes writes asynchronously. */
async function write(screen: HeadlessTerminalType, data: string): Promise<void> {
  await new Promise<void>((resolve) => screen.write(data, resolve))
}

/** The visible grid as plain text, for comparing two terminals cell for cell. */
function visible(screen: HeadlessTerminalType): string[] {
  const buffer = screen.buffer.active
  const lines: string[] = []
  const start = Math.max(0, buffer.length - screen.rows)
  for (let i = start; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  return lines
}

describe('replay frame — fidelity', () => {
  it('carries colour and attributes that plain text threw away', async () => {
    const { screen, frame } = mirror()
    await write(screen, '\x1b[31mRED\x1b[0m \x1b[1;32mBOLDGREEN\x1b[0m \x1b[44mBLUEBG\x1b[0m\r\n')
    const out = frame()
    // The regression this replaces: viewportText() returned the words with
    // every escape stripped, so a reattached viewer lost all styling.
    expect(out).toMatch(/\x1b\[[0-9;]*31/) // red fg
    expect(out).toMatch(/\x1b\[[0-9;]*32/) // green fg
    expect(out).toMatch(/\x1b\[[0-9;]*44/) // blue bg
    expect(out).toContain('BOLDGREEN')
  })

  it('round-trips: a fresh terminal fed the frame shows what the mirror shows', async () => {
    // The strongest statement of "faithful" — and the one that fails loudly if
    // anyone swaps the serializer back for a text dump.
    const { screen, frame } = mirror(40, 10)
    await write(screen, 'first line\r\n')
    await write(screen, '\x1b[33msecond, coloured\x1b[0m\r\n')
    await write(screen, 'third\r\n')

    const viewer = new Terminal({ cols: 40, rows: 10, scrollback: 5000, allowProposedApi: true })
    await write(viewer, frame())
    expect(visible(viewer)).toEqual(visible(screen))
  })

  it('reproduces WRAPPING, which is what a geometry mismatch destroys', async () => {
    // A line longer than the mirror is wide. Re-wrapping this at another width
    // is precisely how rows shift and later absolute addresses land wrong.
    const { screen, frame } = mirror(20, 8)
    await write(screen, 'x'.repeat(55) + '\r\n')

    const viewer = new Terminal({ cols: 20, rows: 8, scrollback: 5000, allowProposedApi: true })
    await write(viewer, frame())
    expect(visible(viewer)).toEqual(visible(screen))
  })

  it('starts by clearing screen AND scrollback so a reattach replaces, never appends', async () => {
    const { screen, frame } = mirror()
    await write(screen, 'fresh content\r\n')
    const out = frame()
    expect(out.startsWith(CLEAR_SCREEN)).toBe(true)
    // 2J screen, 3J scrollback, H home — all three, or a reattach stacks the
    // new frame under whatever the viewer was already showing.
    expect(CLEAR_SCREEN).toBe('\x1b[2J\x1b[3J\x1b[H')
  })

  it('survives an empty mirror without emitting junk', async () => {
    const { frame } = mirror()
    expect(frame().startsWith(CLEAR_SCREEN)).toBe(true)
  })

  it('bounds the payload to about a screenful, not the whole 5000-line scrollback', async () => {
    // A phone on SSE gets one screen, not a megabyte. The guard is the reason
    // `scrollback: screen.rows` is passed rather than the mirror's capacity.
    const { screen, frame } = mirror(40, 6)
    for (let i = 0; i < 400; i += 1) await write(screen, `line ${i}\r\n`)
    const out = frame()
    expect(out).toContain('line 399')
    expect(out).not.toContain('line 100')
    // 6 rows + 6 scrollback lines of ~10 chars — nowhere near the full history.
    expect(out.length).toBeLessThan(2000)
  })
})

describe('replay frame — geometry is declared, not guessed', () => {
  it('serializes at the mirror geometry, which the hello announces', async () => {
    // The frame's wrapping is baked in at these columns, so the viewer has to
    // be told them BEFORE it applies the frame. PtySession.geometry() is that
    // announcement; here we pin that the frame really is laid out at the size
    // being announced.
    const { screen, frame } = mirror(24, 5)
    await write(screen, 'y'.repeat(30) + '\r\n')

    const declared = { cols: screen.cols, rows: screen.rows }
    expect(declared).toEqual({ cols: 24, rows: 5 })

    const matched = new Terminal({ ...declared, scrollback: 5000, allowProposedApi: true })
    await write(matched, frame())
    expect(visible(matched)).toEqual(visible(screen))
  })

  it('a viewer at the WRONG width does not reproduce the mirror — the bug, pinned', async () => {
    // Demonstrates why the geometry hello exists at all: same frame, wrong
    // grid, different result. If this ever starts passing, the hello has
    // stopped mattering and the ordering guarantee can be revisited.
    const { screen, frame } = mirror(20, 8)
    await write(screen, 'z'.repeat(55) + '\r\n')

    const wrong = new Terminal({ cols: 45, rows: 8, scrollback: 5000, allowProposedApi: true })
    await write(wrong, frame())
    expect(visible(wrong)).not.toEqual(visible(screen))
  })
})

describe('planWheelJump — checkpoint jumps without a copy-mode', () => {
  // herdr has no copy-mode to command, but its attach client scrolls 3 lines
  // per SGR wheel notch (measured live: 5 notches -> offset exactly 15, and
  // Escape returns to live). The planner turns "find this text" into a notch
  // count; PtySession writes that many wheel events into the PTY it owns.
  const row = (text: string, wrapped = false): { text: string; wrapped: boolean } => ({
    text,
    wrapped
  })

  it('scrolls the LAST occurrence to the top of the viewport, in notches', () => {
    const rows = [
      row('needle here'),
      ...Array.from({ length: 89 }, (_, i) => row(`line ${i}`))
    ]
    // Match at row 0, buffer 90 rows, viewport 30: target 60 -> 20 notches.
    expect(planWheelJump(rows, 30, 'needle here')).toBe(20)
  })

  it('finds text spanning WRAPPED rows — a long prompt is one logical line', () => {
    const rows = [
      row('the beginning of a very long promp'),
      row('t that wrapped onto the next row', true),
      ...Array.from({ length: 58 }, (_, i) => row(`line ${i}`))
    ]
    expect(planWheelJump(rows, 30, 'long prompt that wrapped')).not.toBeNull()
  })

  it('answers 0 notches when the text is already on the live screen', () => {
    const rows = [...Array.from({ length: 25 }, (_, i) => row(`line ${i}`)), row('needle')]
    expect(planWheelJump(rows, 30, 'needle')).toBe(0)
  })

  it('answers null for absent or blank text — a jump must not scroll blindly', () => {
    expect(planWheelJump([row('a'), row('b')], 30, 'missing')).toBeNull()
    expect(planWheelJump([row('a')], 30, '   ')).toBeNull()
  })
})

describe('modeReplay — a mid-session viewer must adopt the pane modes', () => {
  // serialize() carries buffer content only. Under tmux every viewer saw the
  // init sequences (each attach spawned a fresh client); with a replay
  // baseline nobody does — and a viewer without the mouse-tracking mode never
  // forwards wheel/touch, so the LIVE pane cannot be scrolled (the reported
  // herdr-mode symptom).
  type HeadlessLike = Pick<HeadlessTerminalType, 'modes'>
  const modes = (over: Record<string, unknown>): HeadlessLike['modes'] =>
    ({
      applicationCursorKeysMode: false,
      applicationKeypadMode: false,
      bracketedPasteMode: false,
      insertMode: false,
      mouseTrackingMode: 'none',
      originMode: false,
      reverseWraparoundMode: false,
      sendFocusMode: false,
      wraparoundMode: true,
      ...over
    }) as HeadlessLike['modes']

  it('replays mouse tracking WITH the SGR encoding', () => {
    const seq = modeReplay(modes({ mouseTrackingMode: 'drag' }))
    expect(seq).toContain('\x1b[?1002h')
    expect(seq).toContain('\x1b[?1006h')
  })

  it('replays bracketed paste and application cursor keys', () => {
    const seq = modeReplay(
      modes({ bracketedPasteMode: true, applicationCursorKeysMode: true })
    )
    expect(seq).toContain('\x1b[?2004h')
    expect(seq).toContain('\x1b[?1h')
  })

  it('replays NOTHING for a plain shell pane — no modes, no side effects', () => {
    expect(modeReplay(modes({}))).toBe('')
  })

  it('rides on the frame: a real mirror with mouse tracking produces a frame that re-enables it', () => {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    return new Promise<void>((resolve) => {
      term.write('hello\x1b[?1002h\x1b[?1006h', () => {
        const frame = buildReplayFrame(term, serializer)
        expect(frame).toContain('\x1b[?1002h')
        expect(frame).toContain('\x1b[?1006h')
        resolve()
      })
    })
  })
})
