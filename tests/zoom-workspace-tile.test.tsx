// THE WORKSPACES STOP IS ONE GRID OF TILES (owner, 2026-11-04, a 360px Samsung:
// the title ran under PER ROW, the labels ran over each other, the seals were
// squeezed, and a workspace's artifacts were only numbers). A tile holds its
// two groups on one page: agents in the ring, artifacts in a deck of real
// things, each its own door, the open workspace in the same form.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { deviceCam, deviceWords, SWS } from '../src/renderer/src/zoom/zoom-frame'
import { deviceOf, DECK_POSE, fanOf, stackOf, TILE, tileOf, TILE_SPLIT } from '../src/renderer/src/zoom/zoom-layout'
import { deckOf } from '../src/renderer/src/zoom/use-zoom-fleet'
import { deckDepth, sameTile, WorkspaceTile } from '../src/renderer/src/zoom/WorkspaceTile'
import { buildZoomModel, type MarkView } from '../src/renderer/src/zoom/zoom-model'
import { modelOf, paintAt } from './zoom-qa-helpers'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)
const PHONES = [[320, 640], [360, 724], [375, 680], [412, 760]] as const
const bind = (): ((el: HTMLElement | null) => void) => () => undefined
const noop = (): void => undefined
const mark = (over: Partial<MarkView> = {}): MarkView => ({ id: 'w', name: 'Goat Team', presets: ['Claude Code', 'Codex'], waiting: false, waitingCount: 0, browsers: 26, notes: 6, deck: [], ...over })
const tiles = (d: ReturnType<typeof deviceOf>) => Object.values(d.at).map((p) => ({ left: p.x + SWS * TILE.left, top: p.y + SWS * d.tile.top, right: p.x + SWS * (TILE.left + TILE.w), bottom: p.y + SWS * (d.tile.top + d.tile.h) }))

describe('the tiles', () => {
  it('never overlap, at every pick and count', () => {
    for (const narrow of [true, false]) for (const cols of [2, 3, 4, 5]) for (const n of [2, 8, 13]) {
      const list = tiles(deviceOf(ids(n), narrow, undefined, cols))
      list.forEach((a, i) => list.slice(i + 1).forEach((b) => expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)))
    }
  })

  it('stand in columns: a short last row starts at the left, as a grid does', () => {
    const d = deviceOf(ids(7), false, undefined, 3)
    expect(d.at.w6.x).toBeCloseTo(d.at.w0.x, 6)
  })

  it('hold the ring and the deck inside the frame, the door between them', () => {
    const half = (168 * DECK_POSE.s) / 2
    expect(TILE.left).toBeLessThan(-90)
    expect(DECK_POSE.x + half).toBeLessThan(TILE.left + TILE.w)
    expect(TILE_SPLIT).toBeGreaterThan(90)
    expect(TILE_SPLIT).toBeLessThan(DECK_POSE.x - half)
  })
})

describe("a tile's frame at a pick", () => {
  it("leaves the name and the counts their lines, off the ring, at a phone's every pick", () => {
    for (const [cols, density] of [[2, 'roomy'], [3, 'compact'], [4, 'tiny'], [5, 'tiny']] as const) for (const [w, h] of PHONES) {
      const d = deviceOf(ids(8), true, undefined, cols)
      const px = SWS * deviceCam(d, w, h, true).S
      const head = (-100 - d.tile.top) * px
      const foot = (d.tile.top + d.tile.h - 80) * px
      expect(head, `${cols} at ${w}`).toBeGreaterThanOrEqual(density === 'tiny' ? 18 : 24)
      if (density !== 'tiny') expect(foot, `${cols} at ${w}`).toBeGreaterThanOrEqual(22)
    }
  })

  it('reckons from the row it gets, not the pick, when there are fewer workspaces than the pick', () => {
    const d = deviceOf(ids(3), true, undefined, 5)
    expect(d.tile).toEqual(tileOf(true, 3))
    const px = SWS * deviceCam(d, 360, 724, true).S
    expect((d.tile.top + d.tile.h - 80) * px).toBeGreaterThanOrEqual(22)
  })

  it('keeps one frame on a desk', () => {
    for (const cols of [3, 4, 5]) expect(tileOf(false, cols)).toEqual({ top: TILE.top, h: TILE.h })
  })
})

describe('the phone camera at the workspaces stop', () => {
  it('starts at the top, clear of the per-row pill, and ends above the stop bar', () => {
    for (const [w, h] of PHONES) {
      const d = deviceOf(ids(8), true)
      const cam = deviceCam(d, w, h, true)
      const list = tiles(d)
      const top = Math.min(...list.map((t) => t.top))
      const bottom = Math.max(...list.map((t) => t.bottom))
      expect(cam.Oy + top * cam.S).toBeGreaterThanOrEqual(52)
      // Scrolled to its end, where a short screen has to scroll at all.
      const end = deviceCam(d, w, h, true, 1e6)
      expect(end.Oy + bottom * end.S).toBeLessThanOrEqual(h - 58)
    }
  })

  it('scrolls a tall grid at the same scale, its words still off the rings', () => {
    for (const n of [13, 20, 30]) {
      const d = deviceOf(ids(n), true)
      const cam = deviceCam(d, 360, 724, true)
      expect(cam.S).toBeCloseTo(deviceCam(deviceOf(ids(4), true), 360, 724, true).S, 6)
      expect(cam.panMax).toBeGreaterThan(0)
      expect((-100 - d.tile.top) * SWS * cam.S).toBeGreaterThanOrEqual(24)
      const end = deviceCam(d, 360, 724, true, 1e6)
      expect(end.Oy + -d.gridTop * end.S).toBeLessThanOrEqual(724 - 58)
    }
  })

  it('does not scroll what fits', () => {
    expect(deviceCam(deviceOf(ids(8), true), 360, 724, true).panMax).toBe(0)
    expect(deviceCam(deviceOf(ids(8), false), 1440, 828, false).panMax).toBe(0)
  })

  it('scrolls a desk of many rows, past three, instead of shrinking', () => {
    const three = deviceCam(deviceOf(ids(9), false), 1440, 828, false)
    const many = deviceCam(deviceOf(ids(30), false), 1440, 828, false)
    expect(many.S).toBeCloseTo(three.S, 6)
    expect(many.panMax).toBeGreaterThan(0)
  })

  it('fills the width', () => {
    for (const [w, h] of PHONES) {
      const d = deviceOf(ids(8), true)
      const list = tiles(d)
      const width = (Math.max(...list.map((t) => t.right)) - Math.min(...list.map((t) => t.left))) * deviceCam(d, w, h, true).S
      expect(width).toBeGreaterThanOrEqual(w - 40)
      expect(width).toBeLessThanOrEqual(w - 24)
    }
  })

  it('keeps the title short of the pill', () => {
    for (const [w, h] of PHONES) {
      const words = deviceWords(deviceOf(ids(8), true), w, h, true)
      expect(words.titleMax * words.titleK * words.cam).toBeLessThanOrEqual(w - 16 - 130)
    }
  })

  it('lets the words go as a tile gets small: the word, the split, then the counts', () => {
    const at = (cols: number, w = 360): string => deviceWords(deviceOf(ids(8), true, undefined, cols), w, 724, true).density
    expect(at(2)).toBe('roomy')
    expect(at(2, 320)).toBe('snug')
    expect(at(3)).toBe('compact')
    expect(at(4)).toBe('tiny')
    expect(at(5)).toBe('tiny')
  })
})

describe('the doors', () => {
  it('close where the tiles are only a picture on the machine', () => {
    const at = (sv: number): string => paintAt(modelOf(3, 4), { sv, w: 360, h: 724, narrow: true }).els.device.style.pointerEvents
    expect(at(-2)).toBe('none')
    expect(at(-1.5)).toBe('none')
    expect(at(-1)).toBe('')
    expect(at(1)).toBe('none')
  })

  it('follow their layer, never set their own', () => {
    const css = readFileSync('src/renderer/src/zoom/workspace-tile.css', 'utf8')
    expect(css).toMatch(/\.zv-mark > \.zv-door \{[^}]*pointer-events: inherit;/)
  })
})

describe("the agents' fan", () => {
  it('shows a few faces apart, not a swirl of all of them', () => {
    expect(fanOf(1)).toHaveLength(1)
    expect(fanOf(87)).toHaveLength(6)
    for (const p of fanOf(87)) expect(Math.abs(p.r)).toBeLessThanOrEqual(16)
    const xs = fanOf(87).map((p) => p.x)
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(16)
  })

  it('stacks the open crew in the same fan, the rest waiting under its first', () => {
    const crew = ids(9).map((id) => ({ id, name: id, preset: 'x', orch: false, waiting: false }))
    const s = stackOf(crew)
    const fan = fanOf(9)
    expect(s.w0).toMatchObject({ x: fan[5].x, r: fan[5].r })
    expect(s.w8).toMatchObject({ x: fan[0].x, r: fan[0].r })
    expect(s.w7).toMatchObject({ x: fan[0].x, r: fan[0].r })
  })
})

describe('the deck', () => {
  const att = (id: string, kind: 'browser' | 'note') => ({ id, kind, title: id, shared: false })
  const agent = (attachments: ReturnType<typeof att>[]) => ({ attachments }) as never

  it('leads with the newest browser and shows a note when there is one', () => {
    const deck = deckOf({ agents: [agent([att('a', 'browser'), att('n', 'note')])], loose: [att('b', 'browser'), att('c', 'browser')], newest: att('z', 'browser') })
    expect(deck.map((i) => i.id)).toEqual(['z', 'n', 'c'])
  })

  it('lists each thing once, however many agents wear it', () => {
    const one = att('a', 'browser')
    expect(deckOf({ agents: [agent([one]), agent([one])], loose: [one], newest: one }).map((i) => i.id)).toEqual(['a'])
  })

  it('is as deep as the workspace holds, never deeper than a few sheets', () => {
    expect(deckDepth(0)).toBe(0)
    expect(deckDepth(1)).toBe(1)
    expect(deckDepth(3)).toBe(2)
    expect(deckDepth(12)).toBe(3)
    expect(deckDepth(321)).toBe(4)
  })
})

describe('a tile', () => {
  const render = (m: MarkView, open = false): string => renderToStaticMarkup(<WorkspaceTile mark={m} open={open} bind={bind} onOpen={() => undefined} onOpenItems={() => undefined} />)

  it('has two real doors, named for what they open', () => {
    const html = render(mark())
    expect(html).toContain('aria-label="Open Goat Team agents, 2 agents"')
    expect(html).toContain('aria-label="Open Goat Team artifacts, 26 browsers, 6 notes"')
    expect(html.match(/<button/g)).toHaveLength(2)
  })

  it('never shows a made-up zero: no feed, no artifacts door', () => {
    const html = render(mark({ browsers: null, notes: null }))
    expect(html).not.toContain('artifacts')
    expect(html).not.toContain('zv-deck')
  })

  it('says when a workspace is known to hold nothing, and opens no door on it', () => {
    const html = render(mark({ browsers: 0, notes: 0 }))
    expect(html).toContain('no artifacts')
    expect(html).not.toContain('zv-door items')
    expect(html).toContain('zv-door agents whole')
    expect(render(mark({ presets: [] }))).toContain('no agents')
  })

  it('puts the first agent on top of the fan, as the open crew does', () => {
    const html = render(mark({ presets: ['Claude Code', 'Codex'] }))
    expect(html.indexOf('Codex')).toBeLessThanOrEqual(html.lastIndexOf('Claude Code'))
  })

  it('says which tile is open', () => {
    expect(render(mark(), true)).toContain('aria-current="true"')
    expect(render(mark())).not.toContain('aria-current')
  })

  it('counts who is waiting', () => {
    expect(render(mark({ waiting: true, waitingCount: 3 }))).toContain('3 waiting')
    expect(render(mark())).not.toContain('zv-tile-wait')
  })

  it('leaves the ring and the faces to the scene when open', () => {
    const html = render(mark(), true)
    expect(html).toContain('data-open="true"')
    expect(html).not.toContain('zv-ring')
    expect(html).not.toContain('zv-av')
    expect(render(mark())).toContain('zv-ring')
  })
})

describe('a tile through a rebuild', () => {
  // The model is rebuilt on every crew update: a deck of new objects would redraw every tile each time (same-props.ts).
  const decks = new Map([['w2', [{ id: 'b', kind: 'browser' as const, title: 'b', host: null }]]])
  const node = { kind: 'browser', id: 'n1', name: 'one', tabs: [], position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as never
  const input = { nodes: [node], connections: [], rows: [], crew: [], attachIndex: new Map(), workspaces: [{ id: 'w1', name: 'A', dir: '', dirs: [], icon: '' }, { id: 'w2', name: 'B', dir: '', dirs: [], icon: '' }], decks, activeId: 'w1', name: 'A' }

  it('keeps its deck, so the memo holds', () => {
    const a = buildZoomModel(input)
    const b = buildZoomModel({ ...input })
    expect(a.marks[0].deck).toHaveLength(1)
    const props = (mark: MarkView) => ({ mark, bind, onOpen: noop })
    expect(sameTile(props(a.marks[0]), props(b.marks[0]))).toBe(true)
    expect(a.openMark.deck).toHaveLength(1)
    expect(sameTile(props(a.openMark), props(b.openMark))).toBe(true)
  })

  it('still redraws when what the deck shows changes, a feed delta or not', () => {
    const m = mark({ deck: [{ id: 'b', kind: 'browser', title: 'one', host: 'a', tint: '', initial: 'O', line: '', owners: [] }] })
    const props = (x: MarkView) => ({ mark: x, bind, onOpen: noop })
    expect(sameTile(props(m), props({ ...m, deck: [{ ...m.deck[0] }] }))).toBe(true)
    expect(sameTile(props(m), props({ ...m, deck: [{ ...m.deck[0], title: 'two' }] }))).toBe(false)
    expect(sameTile(props(m), props({ ...m, waitingCount: 1 }))).toBe(false)
  })

  it('does not call an unread canvas empty', () => {
    const m = buildZoomModel({ ...input, nodes: [], loaded: false })
    expect(m.openMark.browsers).toBeNull()
    expect(m.openMark.notes).toBeNull()
    expect(buildZoomModel({ ...input, nodes: [], loaded: true }).openMark.browsers).toBe(0)
  })
})
