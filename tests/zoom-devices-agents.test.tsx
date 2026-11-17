// THE DEVICES STOP SHOWS AGENTS ONLY (owner, 2026-11-17): each machine's screen
// is its workspaces' agents, each face the size a workspace card draws it, and
// the keys walk them agent by agent (zoom-agent-keys.test.ts for the order).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DevicesAgents, groupsOf } from '../src/renderer/src/zoom/DevicesAgents'
import { focusPlace } from '../src/renderer/src/zoom/use-agent-keys'
import { machineViewOf, type AgentView, type MarkView } from '../src/renderer/src/zoom/zoom-model'
import { AGENTS_ONLY, layoutOf, paint, type FrameEls } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf } from './zoom-qa-helpers'

const agent = (id: string, status: AgentView['status']): AgentView => ({ id, name: id.toUpperCase(), preset: 'claude', orch: false, phase: status === 'waiting' ? 'waiting' : 'quiet', status, word: status, line: '', browsers: 0, notes: 0, turn: null })
const mark = (id: string, agents: AgentView[], over: Partial<MarkView> = {}): MarkView => ({ id, name: `WS ${id}`, presets: agents.map((a) => a.preset), waiting: false, waitingCount: 0, browsers: 3, notes: 1, deck: [], agents, ...over })
const draw = (marks: MarkView[], picked: string | null = null, k = 1.25): string =>
  renderToStaticMarkup(<DevicesAgents machine="local" name="MacBook Pro" marks={marks} frame={{ w: 628, h: 403 }} k={k} picked={picked} onPick={() => undefined} onOpenWorkspace={() => undefined} />)

describe("a machine's screen at the devices stop", () => {
  const marks = [mark('a', [agent('a1', 'idle'), agent('a2', 'waiting')], { waitingCount: 1 }), mark('b', [agent('b1', 'working')])]

  it('is each workspace’s name and faces, no deck or screenshot', () => {
    const html = draw(marks)
    expect(html).toContain('WS a')
    expect(html).toContain('WS b')
    expect(html).toContain('2 workspaces')
    expect(html).not.toContain('dm-fan')
    expect(html).not.toContain('dm-page')
    expect(html).not.toContain('▭')
  })

  it('draws a face at a workspace card’s 36 px, the screen scaled by k into the frame’s screen', () => {
    const html = draw(marks, null, 1.25)
    expect(html.match(/width="36"/g)).toHaveLength(3)
    // 628 x 403 less the bezel's 10 a side; in a card's px, that over k.
    expect(html).toContain('left:10px;top:10px;width:608px;height:383px')
    expect(html).toContain('width:486.4px;height:306.4px;transform:scale(1.2500)')
  })

  it('in the order the keys walk: who needs the owner first, as the workspace card', () => {
    const html = draw(marks)
    const drawn = [...html.matchAll(/data-pick="([^"]+)"/g)].map((m) => m[1])
    expect(drawn).toEqual(groupsOf('local', marks).flatMap((g) => g.agents.map((id) => `local|${id}`)))
    expect(drawn.slice(0, 2)).toEqual(['local|a2', 'local|a1'])
  })

  it('rings the agent the keys stand on, and says who waits', () => {
    const html = draw(marks, 'local|b1')
    expect(html).toMatch(/data-pick="local\|b1"[^>]*aria-current="true"/)
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    expect(html).toContain('class="dm-wait">1<')
  })

  it('holds a workspace with nobody in it, and one whose faces nobody is named for', () => {
    const html = draw([mark('e', []), mark('r', [], { presets: ['codex', 'claude'] })])
    expect(html).toContain('no agents')
    expect(html.match(/da-face still/g)).toHaveLength(2)
  })
})

describe("another machine's workspaces carry their agents", () => {
  it('by name and state, from its own feed; without ids only its faces', () => {
    const view = machineViewOf({
      id: 'solis', name: 'Solis-Core', local: false, online: true, detail: 'live',
      workspaces: [
        { id: 'w', name: 'My Workspace', agents: [{ id: 't1', name: 'Scout', harness: 'claude', phase: 'waiting' }, { id: 't2', name: 'Forge', harness: 'codex', phase: 'working' }], counts: { agents: 2, waiting: 1 } },
        { id: 'x', name: 'Old', agents: [{ harness: 'claude', phase: 'quiet' }], counts: null }
      ]
    })
    expect(view.marks[0].agents?.map((a) => [a.id, a.name, a.status])).toEqual([['t1', 'Scout', 'waiting'], ['t2', 'Forge', 'working']])
    expect(view.marks[1].agents).toEqual([])
    expect(view.marks[1].presets).toEqual(['claude'])
  })

  it('in the board’s words: the feed’s thinking is working, an unread reply is done, idle rests', () => {
    const view = machineViewOf({
      id: 'solis', name: 'Solis-Core', local: false, online: true, detail: 'live',
      workspaces: [{ id: 'w', name: 'W', counts: null, agents: (['thinking', 'replied', 'idle', 'offline', 'waiting'] as const).map((phase, i) => ({ id: `t${i}`, name: phase, harness: 'claude', phase })) }]
    })
    expect(view.marks[0].agents?.map((a) => [a.status, a.word])).toEqual([['working', 'working'], ['done', 'done'], ['idle', 'resting'], ['offline', 'offline'], ['waiting', 'needs you']])
  })
})

describe('the painter hands this machine’s frame from its agents to its tiles', () => {
  const part = (): HTMLElement => ({ style: { setProperty: () => undefined } }) as unknown as HTMLElement
  const at = (sv: number): { agents: number; tiles: number } => {
    const model = modelOf(3, 4)
    const els = { devices: part(), device: part(), scene: part(), panel: part(), wash: part(), label: part(), newCap: part(), machine: part(), localAgents: part(), labelW: 200, labelH: 24, agents: new Map(), links: new Map(), items: new Map(), ties: new Map(), marks: new Map(), next: null } as unknown as FrameEls
    paint(model, layoutOf(model, false), els, { dir: 'agents', sv, w: 1440, h: 900, narrow: false, focus: null, leaving: null, leavingAmt: 0, focusItem: null })
    return { agents: Number(els.localAgents!.style.opacity), tiles: Number(els.device.style.opacity) }
  }

  it('agents only at the devices stop, tiles only at the workspaces stop, crossing on the way in', () => {
    expect(at(-2)).toEqual({ agents: 1, tiles: 0 })
    expect(at(-1)).toEqual({ agents: 0, tiles: 1 })
    const mid = at((AGENTS_ONLY[0] + AGENTS_ONLY[1]) / 2)
    expect(mid.agents).toBeGreaterThan(0)
    expect(mid.agents).toBeLessThan(1)
    expect(mid.agents + mid.tiles).toBeCloseTo(1, 3)
  })
})

describe('what holds the focus, for the keys', () => {
  const el = (matches: string[], cls: string[] = []): Element =>
    ({ closest: (sel: string) => (sel.split(',').some((one) => matches.includes(one.trim())) ? { classList: { contains: (c: string) => cls.includes(c) } } : null) }) as unknown as Element

  it('the page, the popped card’s box, or somewhere with keys of its own', () => {
    expect(focusPlace(null)).toBe('page')
    expect(focusPlace(el([]))).toBe('page')
    expect(focusPlace(el(['.zv-pick-card .zv-reply input']))).toBe('box')
    expect(focusPlace(el(['.dm-ov-layer .zv-reply input']))).toBe('box')
    // A card's name being renamed (NameEdit.tsx) keeps its own Tab and arrows.
    expect(focusPlace(el(['input']))).toBe('elsewhere')
    expect(focusPlace(el(['.zv-bar-card']))).toBe('elsewhere')
    expect(focusPlace(el(['textarea']))).toBe('elsewhere')
    expect(focusPlace(el(['.xterm']))).toBe('elsewhere')
    expect(focusPlace(el(['.cr-prompt']))).toBe('elsewhere')
    expect(focusPlace(el(['[role="dialog"]']))).toBe('elsewhere')
    expect(focusPlace(el(['[role="dialog"]'], ['zv-pick-card']))).toBe('page')
  })
})

describe('the zoom view wires the keys where they work', () => {
  const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
  it('at rest on the devices or workspaces stop, never in a full view or inside another machine', () => {
    expect(view).toMatch(/if \(z\.full !== null \|\| remotePlace\.get\(\)\.machine\) return null/)
    expect(view).toMatch(/Math\.abs\(z\.v \+ 2\) < 0\.1 \? 'devices' : Math\.abs\(z\.v \+ 1\) < 0\.1 \? 'workspaces' : null/)
  })
  it('across machines at the devices stop, this machine only at the workspaces stop', () => {
    expect(view).toMatch(/stop === 'workspaces' \? groupsOf\(LOCAL_MACHINE, localMarks\) : \[\.\.\.groupsOf\(LOCAL_MACHINE, localMarks\), \.\.\.others\.filter\(\(o\) => o\.say === null\)/)
  })
})
