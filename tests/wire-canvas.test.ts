import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTE_WIRE_HEAD, lightenCanvas, noteIsWhole } from '../src/shared/wire-canvas'
import type { CanvasNode, NoteNodeData, WorkspaceState } from '../src/shared/model'

/**
 * THE FIRST FRAME OF A WORKSPACE SWITCH — the canvas, minus the reading.
 *
 * Measured on the owner's own machine (2026-09-28): switching workspace over
 * the relay delivers the whole canvas in one SSE frame, 722 KB raw and 280 KB
 * gzipped, and 82% of it is NOTE BODIES — 584 KB of markdown across 75 notes,
 * two of which hold 242 KB between them. None of it is drawn at the moment it
 * arrives: a note renders as a mini tile until it is zoomed to a readable
 * size, which is exactly why the overview is affordable at all.
 *
 * So the switch sends the canvas twice: once light, so it can be DRAWN, and
 * once whole, a beat later, so nothing is missing. The light frame is the one
 * the reader waits for, and it is about five times smaller.
 *
 * ONLY ON A SWITCH. Every other canvas change sends one frame as before —
 * two-framing an ordinary edit would double the traffic of dragging a card.
 *
 * A LIGHTENED NOTE SAYS SO, in `contentBytes`: the full length, beside a body
 * that is shorter than it. Nothing has to infer it, and nothing may write over
 * a note it only half has (NoteNode refuses to edit one).
 */

const note = (id: string, content: string): NoteNodeData => ({
  kind: 'note',
  id,
  name: id,
  customName: null,
  content,
  locked: false,
  position: { x: 0, y: 0 },
  size: { width: 300, height: 200 },
})

const state = (nodes: CanvasNode[]): WorkspaceState => ({
  name: 'W',
  dir: '/w',
  dirs: ['/w'],
  nodes,
  connections: [],
})

const long = (n: number): string => 'x'.repeat(n)

describe('lightening a canvas for the first frame', () => {
  it('cuts a long note down to its head and says how long the whole is', () => {
    const light = lightenCanvas(state([note('a', long(50_000))]))
    expect(light).not.toBeNull()
    const [cut] = (light as WorkspaceState).nodes as NoteNodeData[]
    expect(cut.content).toHaveLength(NOTE_WIRE_HEAD)
    expect(cut.contentBytes).toBe(50_000)
    expect(noteIsWhole(cut)).toBe(false)
  })

  it('leaves a note that already fits completely alone, with no marker', () => {
    const whole = note('a', 'short enough to read on a card')
    const light = lightenCanvas(state([whole, note('b', long(50_000))]))
    const [kept] = (light as WorkspaceState).nodes as NoteNodeData[]
    expect(kept.content).toBe(whole.content)
    expect(kept.contentBytes).toBeUndefined()
    expect(noteIsWhole(kept)).toBe(true)
  })

  it('answers null when there is nothing to lighten — the caller sends one frame', () => {
    // Nothing gained by sending a canvas twice when both copies are the same.
    expect(lightenCanvas(state([note('a', 'tiny')]))).toBeNull()
    expect(lightenCanvas(state([]))).toBeNull()
  })

  it('touches nothing but note bodies', () => {
    const terminal = { kind: 'terminal', id: 't', name: 'Agent' } as unknown as CanvasNode
    const light = lightenCanvas(state([terminal, note('a', long(50_000))])) as WorkspaceState
    expect(light.nodes[0]).toBe(terminal)
    expect(light.name).toBe('W')
    expect(light.connections).toEqual([])
  })

  it('never mutates the state it was given — the full frame follows it', () => {
    const original = note('a', long(50_000))
    const canvas = state([original])
    lightenCanvas(canvas)
    expect(original.content).toHaveLength(50_000)
    expect((original as NoteNodeData).contentBytes).toBeUndefined()
    expect(canvas.nodes[0]).toBe(original)
  })

  it('is a big enough head to be worth having on a card and on a board row', () => {
    // The board's note row shows an excerpt and the canvas card shows the
    // start of the markdown; both come out of this one cut.
    expect(NOTE_WIRE_HEAD).toBeGreaterThanOrEqual(400)
  })
})

describe('whether a note is whole', () => {
  it('is true for a note nobody cut, however long', () => {
    expect(noteIsWhole(note('a', long(99_000)))).toBe(true)
  })

  it('is false only while the body is shorter than the length it declares', () => {
    expect(noteIsWhole({ ...note('a', 'abc'), contentBytes: 9 })).toBe(false)
    expect(noteIsWhole({ ...note('a', 'abcdefghi'), contentBytes: 9 })).toBe(true)
  })
})

/**
 * A SOURCE PROXY for the two places a half-held note could be destroyed, and
 * for the one place the second frame is sent from. None can be reached by a
 * static render (the guard is a branch inside a handler) and all three are
 * one-line rules that a refactor would quietly drop.
 */
describe('nothing writes over a note it only half has', () => {
  const noteNode = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'src', 'nodes', 'NoteNode.tsx'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')

  it('asks whether the body is whole before it opens the editor', () => {
    expect(noteNode).toContain('const whole = noteIsWhole(node)')
    expect(noteNode).toContain('if (!node.locked && whole) setEditing(true)')
  })

  it('asks again at the commit — the body can land mid-edit, and the save is what deletes', () => {
    expect(noteNode).toContain('if (whole && draft !== node.content)')
  })
})

describe('only a switch sends the canvas twice', () => {
  const api = readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'mobile-api.ts'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')

  it('lightens only the change that followed a switch', () => {
    expect(api).toContain('const light = wasSwitch ? lightenCanvas(state) : null')
    // Nothing to cut, one frame: two identical canvases help nobody.
    expect(api).toContain('if (light === null) { send("workspace", state); return; }')
  })

  it('sends the whole canvas after it, and not into a stream that has gone', () => {
    expect(api).toContain('if (response.writableEnded || response.destroyed) return;')
    expect(api).toMatch(/setImmediate\(\(\) => \{[^}]*send\("workspace", state\);/)
  })

  it('takes the switch listener off with the rest — one leak per phone otherwise', () => {
    expect(api).toContain('store.removeListener("switch", onSwitch);')
  })
})
