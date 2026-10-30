// A REPLAY WITH THE PANE'S HISTORY ABOVE THE SCREEN (main/pty.ts ·
// buildSeededFrame), round-tripped through a real headless terminal: the
// history lands in the viewer's SCROLLBACK, the screen is the mirror's cell
// for cell, nothing is shown twice, and the marker is the last thing parsed.
import { describe, expect, it } from 'vitest'
import xtermHeadless from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { buildSeededFrame, seedMarker, SEED_OSC } from '../src/main/pty'
import type { Terminal as HeadlessTerminalType } from '@xterm/headless'

const { Terminal } = xtermHeadless as unknown as { Terminal: typeof HeadlessTerminalType }
const write = (t: HeadlessTerminalType, data: string): Promise<void> => new Promise((r) => t.write(data, r))
const all = (t: HeadlessTerminalType): string[] => {
  const b = t.buffer.active
  return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '')
}
const visible = (t: HeadlessTerminalType): string[] => all(t).slice(t.buffer.active.baseY)

describe('buildSeededFrame', () => {
  it('lays the history into the scrollback and paints the screen as the mirror has it', async () => {
    const rows = 5
    const mirror = new Terminal({ cols: 30, rows, scrollback: 5000, allowProposedApi: true })
    const serializer = new SerializeAddon()
    mirror.loadAddon(serializer)
    // The pane repaints in place: the mirror holds one screen, no scrollback.
    await write(mirror, '\x1b[H\x1b[2J' + ['s1', 's2', '\x1b[31ms3 red\x1b[0m', 's4', 's5'].join('\r\n'))
    // herdr's history: older lines, then the same screen at the end.
    const history = [...Array.from({ length: 8 }, (_, i) => `h${i + 1}`), 's1', 's2', 's3 red', 's4', 's5'].join('\r\n') + '\r\n'

    const viewer = new Terminal({ cols: 30, rows, scrollback: 1000, allowProposedApi: true })
    const marks: string[] = []
    viewer.parser.registerOscHandler(SEED_OSC, (data) => {
      marks.push(data)
      // The marker comes last: the screen is already painted when it fires.
      expect(visible(viewer)).toEqual(['s1', 's2', 's3 red', 's4', 's5'])
      return true
    })
    await write(viewer, 'stale screen from before\r\n')
    await write(viewer, buildSeededFrame(mirror, serializer, history, 'n1'))

    expect(marks).toEqual(['cookrew-seed;n1'])
    expect(visible(viewer)).toEqual(visible(mirror))
    const scrollback = all(viewer).slice(0, viewer.buffer.active.baseY)
    expect(scrollback.slice(0, 8)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'])
    // The screen's own lines are not repeated above it; the stale line is gone.
    expect(scrollback.filter((l) => l === 's1')).toEqual([])
    expect(all(viewer)).not.toContain('stale screen from before')
    expect(viewer.buffer.active.type).toBe('normal')
  })

  it('with no history above the screen it is a plain replay, still marked', async () => {
    const mirror = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true })
    const serializer = new SerializeAddon()
    mirror.loadAddon(serializer)
    await write(mirror, 'a\r\nb\r\nc')
    const frame = buildSeededFrame(mirror, serializer, 'a\r\nb\r\nc\r\n', 'x')
    expect(frame.endsWith(seedMarker('x'))).toBe(true)
    expect(frame).not.toContain('\x1b[H\x1b[2J' + '\r\n')
  })
})
