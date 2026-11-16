// THE BAR'S GROUPS ARE THE HUMAN-IN-THE-LOOP INBOX (owner, 2026-11-04; cut
// docs/avatar-send-tasks/e-groups): the zoom bar's AGENTS | ARTIFACTS pair
// becomes two groups in the troop's own form, ARTIFACTS first, AGENTS next to
// the prompt's face. Each holds what needs you: agents waiting on you, then
// replies not read; browsers and notes an agent made or changed since you last
// looked (the seen book and the log: tests/hitl-bar.test.ts).
// Pure rules here; the source contract below.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BAR_SIDES } from '../src/renderer/src/zoom/zoom-path'
import { agentInbox, groupSize, sinceWord, withHeld } from '../src/renderer/src/zoom/bar-inbox'
import { barCardSpot } from '../src/renderer/src/zoom/BarCards'
import { barCard, FROM_FRESH_MS } from '../src/renderer/src/zoom/bar-pick'
import { pageInView } from '../src/renderer/src/page-in-view'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')

type Row = Parameters<typeof agentInbox>[0][number]
const row = (id: string, phase: Row['phase'], at: number, unread = false): Row => ({ id, phase, unread, lastActivityAt: at })

describe('the order: ARTIFACTS first, AGENTS next to the face', () => {
  it('swaps the pair, each still its stop', () => {
    expect(BAR_SIDES.map((s) => s.name)).toEqual(['artifacts', 'agents'])
    expect(BAR_SIDES.map((s) => [s.dir, s.v])).toEqual([['items', 0], ['agents', 1]])
  })
})

describe('what the AGENTS group holds', () => {
  it('waiting on you first, then a reply not read yet; working and resting are not in it', () => {
    const rows = [row('work', 'working', 50), row('rest', 'quiet', 60), row('read', 'done', 70), row('reply', 'done', 80, true), row('wait1', 'waiting', 10), row('wait2', 'waiting', 30), row('off', 'offline', 90)]
    expect(agentInbox(rows).map((e) => [e.id, e.why])).toEqual([['wait2', 'waiting'], ['wait1', 'waiting'], ['reply', 'reply']])
  })
  it('a reply is in it while the tracker says unread, and no time on this device moves that', () => {
    const r = row('reply', 'done', 80, true)
    expect(agentInbox([r]).map((e) => e.id)).toEqual(['reply'])
    expect(agentInbox([{ ...r, unread: false }])).toEqual([])
    expect(agentInbox([{ ...r, unread: false, lastActivityAt: 999_999 }])).toEqual([])
  })
  it('opening its card reads it for every device; the seen book holds no replies', () => {
    const groups = read('zoom', 'BarGroups.tsx')
    expect(groups).toContain("if (agentById.get(id)?.why === 'reply') cookrew().turnSeen(id)")
    expect(groups).not.toContain('replySig')
  })
  it('a waiting agent stays until it is answered, card opened or not', () => {
    const w = row('w', 'waiting', 5)
    expect(agentInbox([w]).map((e) => e.id)).toEqual(['w'])
  })
})

describe('a look needs the window in view', () => {
  const page = (visibilityState: DocumentVisibilityState, focused: boolean): Pick<Document, 'visibilityState' | 'hasFocus'> => ({ visibilityState, hasFocus: () => focused })
  it('only a visible, focused window is looking', () => {
    expect(pageInView(page('visible', true))).toBe(true)
    expect(pageInView(page('visible', false))).toBe(false)
    expect(pageInView(page('hidden', false))).toBe(false)
    expect(pageInView(page('hidden', true))).toBe(false)
  })
  it('a reply that lands behind another app is not read by the view left open', () => {
    expect(read('TerminalOverlay.tsx')).toContain("if (phase === 'replied' && pageInView()) cookrew().turnSeen(node.id)")
    const groups = read('zoom', 'BarGroups.tsx')
    expect(groups).toContain('fullItem && fullAt !== null && pageInView()')
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
