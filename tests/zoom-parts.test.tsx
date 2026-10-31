// THE NAVIGATOR'S PARTS (renderer zoom/ZoomParts.tsx), as markup: an agent's
// face, name, state, counts and quick reply; a link's two-faced coin and its
// shared mark; an item's thumbnail with who uses it; a workspace mark; another
// machine. Static markup, the house way (no DOM env).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentNode, ItemNode, LinkNode, MachineNode, MarkNode, type Bind } from '../src/renderer/src/zoom/ZoomParts'
import type { AgentView, ItemView, MachineView, MarkView } from '../src/renderer/src/zoom/zoom-model'

const bind: Bind = () => () => undefined
const agent = (over: Partial<AgentView> = {}): AgentView => ({
  id: 't1', name: 'Forge', preset: 'Claude Code', orch: false, phase: 'waiting', word: 'needs you',
  line: 'push feat/route-core to origin? needs your yes', browsers: 2, notes: 1, ...over
})
const item = (over: Partial<ItemView> = {}): ItemView => ({
  id: 'b1', kind: 'browser', title: 'PR #82', host: 'github.com/cookrew', tint: '#5d6b7a', initial: 'P',
  line: 'https://github.com/cookrew/x', owners: ['t1', 't2'], ...over
})

describe('an agent’s card', () => {
  it('says its state, its browsers and notes, its last line, and offers a quick reply', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent()} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('Forge')
    expect(html).toContain('needs you')
    expect(html).toContain('2')
    expect(html).toContain('push feat/route-core')
    expect(html).toContain('Reply to Forge…')
    expect(html).toContain('zv-av')
    // A face can be reached and pressed from the keyboard.
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('says so when an agent carries nothing, and keeps the same card shape', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent({ browsers: 0, notes: 0 })} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('no browser or note')
  })
})

describe('a link and an item', () => {
  it('draws the item’s face, its agent’s face, and ×N when it is shared', () => {
    const html = renderToStaticMarkup(<LinkNode k="t1|b1" item={item()} agent={agent()} shared={3} bind={bind} onClick={() => undefined} />)
    expect(html).toContain('zv-coin')
    expect(html).toContain('×3')
    expect(html).toContain('PR #82 · Forge · shared by 3')
  })

  it('names the item, its address, and everyone who uses it', () => {
    const html = renderToStaticMarkup(<ItemNode item={item()} names={['Forge', 'Tinker']} bind={bind} onClick={() => undefined} />)
    expect(html).toContain('PR #82')
    expect(html).toContain('github.com/cookrew')
    expect(html).toContain('2 agents · Forge, Tinker')
  })

  it('says a note is a note and a browser its initial', () => {
    const note = renderToStaticMarkup(<ItemNode item={item({ kind: 'note', title: 'Plan', line: 'four lanes' })} names={[]} bind={bind} onClick={() => undefined} />)
    expect(note).toContain('note')
    expect(note).toContain('no agent')
  })
})

describe('a workspace and a machine', () => {
  it('seals the agent count and names the workspace', () => {
    const mark: MarkView = { id: 'w2', name: 'Home', presets: ['Claude Code', 'Codex'], waiting: true }
    const html = renderToStaticMarkup(<MarkNode mark={mark} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('Home')
    expect(html).toContain('zv-seal">2<')
    expect(html).toContain('zv-mark-dot')
  })

  it('shows a machine’s workspaces, and says “listed only” when it cannot be read', () => {
    const machine: MachineView = { id: 'm2', name: 'Mac mini', local: false, online: true, detail: 'listed', workspaces: [{ id: 'z', name: 'Home lab', presets: [], waiting: false }], agents: null, waiting: null }
    const html = renderToStaticMarkup(<MachineNode machine={machine} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('Mac mini')
    expect(html).toContain('Home lab')
    expect(html).toContain('listed only')
    expect(html).not.toContain('0 agents')
  })
})

describe('the zoom is driven by clicks, not the wheel (owner, 2026-10-31)', () => {
  const source = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
  it('has no wheel zoom at all: no wheel listener, no deltaY, no ctrl-pinch', () => {
    expect(source).not.toMatch(/addEventListener\('wheel'/)
    expect(source).not.toContain('deltaY')
    expect(source).not.toContain('ctrlKey')
  })

  it('steps out on a click on the background, and not after a pinch or a drag', () => {
    expect(source).toContain('stepBack')
    expect(source).toMatch(/if \(moved\.current \|\| pinch\.current !== null\) return/)
    // A click that landed on a node is that node's, and zooms in.
    expect(source).toMatch(/closest\('button, input, textarea, form, a, \[role="button"\], \.zv-m, \.zv-card, \.zv-ip, \.zv-lk, \.zv-mark/)
    // …and the handler that does step out is the same one: the guard above it,
    // then the node test, then the step.
    const click = source.slice(source.indexOf('onClick={(e) => {'))
    expect(click.slice(0, 900)).toContain('stepBack()')
  })

  it('keeps the back button, the stops and Esc, and still zooms in on a click', () => {
    expect(source).toContain('aria-label="Zoom out"')
    expect(source).toContain('zv-stops')
    expect(source).toMatch(/e\.key !== 'Escape'/)
    expect(source).toContain('motion.agent(a.id)')
    expect(source).toContain('motion.item(i.id)')
  })
})
