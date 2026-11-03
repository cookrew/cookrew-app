// THE BAR'S GROUPS ARE THE HUMAN-IN-THE-LOOP INBOX (owner, 2026-11-04; cut
// docs/avatar-send-tasks/e-groups): the zoom bar's AGENTS | ARTIFACTS pair
// becomes two groups in the troop's own form, ARTIFACTS first, AGENTS next to
// the prompt's face. Each holds what needs you: agents waiting on you, then
// replies not read; browsers and notes made or changed since you last looked.
// Pure rules here; the source contract below.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BAR_SIDES } from '../src/renderer/src/zoom/zoom-path'
import { EMPTY_PAGE, itemSig, markSeen, observe, pageOf, readBook, replySig, isUnseen } from '../src/renderer/src/zoom/bar-seen'
import { agentInbox, groupSize, itemInbox, sinceWord, withHeld } from '../src/renderer/src/zoom/bar-inbox'
import { barCardSpot } from '../src/renderer/src/zoom/BarCards'
import { barCard, FROM_FRESH_MS } from '../src/renderer/src/zoom/bar-pick'
import type { CanvasNode } from '../src/shared/model'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')

const browser = (id: string, url: string): CanvasNode =>
  ({ kind: 'browser', id, name: id, url, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as unknown as CanvasNode
const note = (id: string, content: string): CanvasNode =>
  ({ kind: 'note', id, name: id, content, customName: id, locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as unknown as CanvasNode

type Row = Parameters<typeof agentInbox>[0][number]
const row = (id: string, phase: Row['phase'], at: number, unread = false): Row => ({ id, phase, unread, lastActivityAt: at })

describe('the order: ARTIFACTS first, AGENTS next to the face', () => {
  it('swaps the pair, each still its stop', () => {
    expect(BAR_SIDES.map((s) => s.name)).toEqual(['artifacts', 'agents'])
    expect(BAR_SIDES.map((s) => [s.dir, s.v])).toEqual([['items', 0], ['agents', 1]])
  })
})

describe("an item's change: what it is now", () => {
  it('a browser is its address, a note its words; anything else none', () => {
    expect(itemSig(browser('b', 'https://a.dev/1'))).toBe(itemSig(browser('b', 'https://a.dev/1')))
    expect(itemSig(browser('b', 'https://a.dev/1'))).not.toBe(itemSig(browser('b', 'https://a.dev/2')))
    expect(itemSig(note('n', 'one'))).not.toBe(itemSig(note('n', 'two')))
    expect(itemSig({ kind: 'terminal', id: 't' } as unknown as CanvasNode)).toBeNull()
  })
})

describe('the seen book (since you last looked)', () => {
  const ws = 'w1'
  it('the first look at a workspace is the baseline: nothing in it is new', () => {
    const book = observe({}, ws, [{ id: 'a', sig: 'x' }, { id: 'b', sig: 'y' }], 100)
    expect(pageOf(book, ws).based).toBe(true)
    expect(isUnseen(pageOf(book, ws), 'a', 'x')).toBe(false)
    expect(isUnseen(pageOf(book, ws), 'b', 'y')).toBe(false)
  })
  it('an empty look sets no baseline (the board still loading)', () => {
    expect(observe({}, ws, [], 100)).toEqual({})
  })
  it('made or changed after it is new, noticed at the moment it was first seen so', () => {
    let book = observe({}, ws, [{ id: 'a', sig: 'x' }], 100)
    book = observe(book, ws, [{ id: 'a', sig: 'x2' }, { id: 'c', sig: 'z' }], 200)
    const page = pageOf(book, ws)
    expect(isUnseen(page, 'a', 'x2')).toBe(true)
    expect(isUnseen(page, 'c', 'z')).toBe(true)
    expect(page.noticed.c).toEqual(['z', 200])
    // Looked at again later, unchanged: still noticed when it first was.
    expect(pageOf(observe(book, ws, [{ id: 'c', sig: 'z' }], 900), ws).noticed.c).toEqual(['z', 200])
  })
  it('nothing new is no new book (no write)', () => {
    const book = observe({}, ws, [{ id: 'a', sig: 'x' }], 100)
    expect(observe(book, ws, [{ id: 'a', sig: 'x' }], 300)).toBe(book)
  })
  it('seen (its card or full view opened) leaves it; a later change brings it back', () => {
    let book = observe({}, ws, [{ id: 'a', sig: 'x' }], 100)
    book = observe(book, ws, [{ id: 'a', sig: 'x2' }], 200)
    book = markSeen(book, ws, 'a', 'x2')
    expect(isUnseen(pageOf(book, ws), 'a', 'x2')).toBe(false)
    expect(pageOf(book, ws).noticed.a).toBeUndefined()
    book = observe(book, ws, [{ id: 'a', sig: 'x3' }], 300)
    expect(isUnseen(pageOf(book, ws), 'a', 'x3')).toBe(true)
  })
  it('an item deleted before it was seen leaves the noticed list', () => {
    let book = observe({}, ws, [{ id: 'a', sig: 'x' }], 100)
    book = observe(book, ws, [{ id: 'a', sig: 'x' }, { id: 'tmp', sig: 't' }], 200)
    expect(pageOf(book, ws).noticed.tmp).toEqual(['t', 200])
    book = observe(book, ws, [{ id: 'a', sig: 'x' }], 300)
    expect(pageOf(book, ws).noticed.tmp).toBeUndefined()
  })
  it("pruning a big page keeps the agents' read replies", () => {
    const many = Array.from({ length: 4001 }, (_, k) => ({ id: `i${k}`, sig: 'b1' }))
    let book = observe({}, ws, many, 1)
    book = markSeen(book, ws, 'agent1', 'r55')
    book = observe(book, ws, [{ id: 'i0', sig: 'b1' }], 2)
    expect(pageOf(book, ws).seen).toEqual({ i0: 'b1', agent1: 'r55' })
  })
  it('never mutates the book it was given', () => {
    const book = Object.freeze(observe({}, ws, [{ id: 'a', sig: 'x' }], 100))
    expect(() => markSeen(book, ws, 'a', 'y')).not.toThrow()
    expect(pageOf(book, ws).seen.a).toBe('x')
  })
  it('reads back what it wrote, and a broken store as empty', () => {
    const book = observe({}, ws, [{ id: 'a', sig: 'x' }], 100)
    expect(readBook(JSON.stringify(book))).toEqual(book)
    expect(readBook('{nope')).toEqual({})
    expect(readBook(null)).toEqual({})
    expect(readBook('[1,2]')).toEqual({})
    expect(pageOf({}, 'other')).toBe(EMPTY_PAGE)
  })
})

describe('what the AGENTS group holds', () => {
  it('waiting on you first, then a reply not read yet; working and resting are not in it', () => {
    const rows = [row('work', 'working', 50), row('rest', 'quiet', 60), row('read', 'done', 70), row('reply', 'done', 80, true), row('wait1', 'waiting', 10), row('wait2', 'waiting', 30), row('off', 'offline', 90)]
    expect(agentInbox(rows, EMPTY_PAGE).map((e) => [e.id, e.why])).toEqual([['wait2', 'waiting'], ['wait1', 'waiting'], ['reply', 'reply']])
  })
  it('a reply seen (its card or full view opened) leaves; the next reply comes back', () => {
    const r = row('reply', 'done', 80, true)
    const page = pageOf(markSeen({}, 'w', 'reply', replySig(r)), 'w')
    expect(agentInbox([r], page)).toEqual([])
    expect(agentInbox([{ ...r, lastActivityAt: 81 }], page).map((e) => e.id)).toEqual(['reply'])
  })
  it('a waiting agent stays until it is answered, card opened or not', () => {
    const w = row('w', 'waiting', 5)
    expect(agentInbox([w], pageOf(markSeen({}, 'x', 'w', replySig(w)), 'x')).map((e) => e.id)).toEqual(['w'])
  })
})

describe('what the ARTIFACTS group holds', () => {
  it('browsers and notes made or changed since you last looked, newest first', () => {
    let book = observe({}, 'w', [{ id: 'old', sig: 'o' }], 1)
    // Newest made first, as the board's nodes reversed give them.
    const now = [{ id: 'c', sig: 'c1' }, { id: 'b', sig: 'b1' }, { id: 'old', sig: 'o2' }]
    book = observe(book, 'w', now, 10)
    // c and b noticed at 10 together, old changed and noticed at 10 too: the made order breaks the tie.
    expect(itemInbox(now, pageOf(book, 'w')).map((e) => e.id)).toEqual(['c', 'b', 'old'])
    // Changed again later: it rises to the front.
    const later = [{ id: 'c', sig: 'c1' }, { id: 'b', sig: 'b2' }, { id: 'old', sig: 'o2' }]
    book = observe(book, 'w', later, 20)
    expect(itemInbox(later, pageOf(book, 'w')).map((e) => [e.id, e.at])).toEqual([['b', 20], ['c', 10], ['old', 10]])
  })
  it('nothing new before the baseline is set: the first look holds nothing', () => {
    expect(itemInbox([{ id: 'a', sig: 'x' }], EMPTY_PAGE)).toEqual([])
  })
})

describe('how many a group shows', () => {
  it('a phone 3 and "+N"; the desktop the word and 5', () => {
    expect(groupSize(true)).toBe(3)
    expect(groupSize(false)).toBe(5)
  })
  it('the open card keeps its face in the stack until it closes (tap again: full view)', () => {
    expect(withHeld(['a', 'b'], ['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c'])
    expect(withHeld(['a', 'b'], ['a', 'b', 'c'], null)).toEqual(['a', 'b'])
    // Held where it stood, not tacked on at the end.
    expect(withHeld(['a', 'c'], ['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c'])
    expect(withHeld(['a'], ['a', 'b'], 'zz')).toEqual(['a'])
  })
})

describe("an artifact's card says when it came", () => {
  it('new, and how long ago it was noticed', () => {
    expect(sinceWord(null, 0)).toBe('new')
    expect(sinceWord(1000, 30_000)).toBe('new · just now')
    expect(sinceWord(0, 2 * 60_000 + 5)).toBe('new · 2 m ago')
    expect(sinceWord(0, 3 * 3_600_000)).toBe('new · 3 h ago')
    expect(sinceWord(0, 50 * 3_600_000)).toBe('new · 2 d ago')
  })
})

describe("where a group's card stands", () => {
  const face = { left: 300, top: 800, width: 26, height: 26 }
  it('over the face, above the bar, centred and kept on screen', () => {
    expect(barCardSpot(face, { width: 200, height: 150 }, 1440, 2000, 50)).toEqual({ left: 213, top: 640 })
    expect(barCardSpot({ ...face, left: 2 }, { width: 200, height: 150 }, 1440, 2000, 50).left).toBe(8)
    expect(barCardSpot({ ...face, left: 1430 }, { width: 200, height: 150 }, 1440, 2000, 50).left).toBe(1232)
  })
  it('above the open box when the box stands higher than the face', () => {
    expect(barCardSpot(face, { width: 200, height: 150 }, 1440, 700, 50).top).toBe(540)
  })
  it('pinned under the stage top when there is no room', () => {
    expect(barCardSpot(face, { width: 200, height: 900 }, 1440, 2000, 50).top).toBe(58)
  })
})

describe("the bar's card: one at a time, and where the face flies from", () => {
  it('opens and closes, an agent card naming the agent the box carries', () => {
    barCard.close()
    expect(barCard.get()).toBeNull()
    barCard.open({ kind: 'agent', id: 'a1' })
    expect(barCard.get()).toEqual({ kind: 'agent', id: 'a1' })
    expect(barCard.agent()).toBe('a1')
    barCard.open({ kind: 'item', id: 'i1' })
    expect(barCard.agent()).toBeNull()
    barCard.close()
    expect(barCard.get()).toBeNull()
  })
  it("gives the tapped face's place to the flight once, and only while fresh", () => {
    const box = { left: 1, top: 2, width: 30, height: 30 }
    barCard.open({ kind: 'agent', id: 'a1' }, box, 1000)
    expect(barCard.takeFrom(1000 + FROM_FRESH_MS + 1)).toBeNull()
    barCard.open({ kind: 'agent', id: 'a1' }, box, 2000)
    expect(barCard.takeFrom(2010)).toEqual(box)
    expect(barCard.takeFrom(2011)).toBeNull()
    barCard.close()
  })
})

describe('the source contract', () => {
  const zoom = read('zoom', 'ZoomView.tsx')
  const groups = read('zoom', 'BarGroups.tsx')
  const prompt = read('prompt', 'GlobalPrompt.tsx')
  it('the groups stand in the stops, in place of the pair', () => {
    expect(zoom).toContain('<BarGroups')
    expect(zoom).not.toContain('className="zv-side"')
    // Each stop keeps its word in the DOM and as its aria-label (probes find '.zv-stops button' by text).
    expect(groups).toMatch(/aria-label=\{s\.name\}/)
    expect(groups).toContain('zv-group-word')
    expect(groups).toContain("aria-current={lit ? 'step' : undefined}")
    expect(zoom).toMatch(/<BarGroups[\s\S]{0,800}motion\.go/)
  })
  it('an agent from a group is the agent the box carries, its face flying from the group', () => {
    expect(prompt).toMatch(/fullAgentId \?\? barAgent \?\? cardAgent \?\?/)
    expect(prompt).toContain('barCard.takeFrom()')
  })
  it("Esc closes the bar's card first, before the box or the view", () => {
    expect(zoom).toMatch(/barCard\.get\(\)[\s\S]{0,200}barCard\.close\(\)/)
  })
})
