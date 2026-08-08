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
import { buildReplayFrame, CLEAR_SCREEN } from '../src/main/pty'
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
