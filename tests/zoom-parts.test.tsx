// THE NAVIGATOR'S PARTS (renderer zoom/ZoomParts.tsx), as markup: an agent's
// face, name, state, counts and quick reply; a link's two-faced coin and its
// shared mark; an item's thumbnail with who uses it; a workspace mark; another
// machine. Static markup, the house way (no DOM env).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentNode, ItemNode, LinkNode, MachineNode, type Bind } from '../src/renderer/src/zoom/ZoomParts'
import type { AgentView, ItemView, MachineView, MarkView } from '../src/renderer/src/zoom/zoom-model'

const bind: Bind = () => () => undefined
const agent = (over: Partial<AgentView> = {}): AgentView => ({
  id: 't1', name: 'Forge', preset: 'Claude Code', orch: false, phase: 'waiting', status: 'waiting', word: 'needs you',
  line: 'push feat/route-core to origin? needs your yes', browsers: 2, notes: 1, turn: null, ...over
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

  // One card, one latest (the owner, 2026-10-31): the turn the pet card says,
  // on the zoom card too — headline, your ask, the tool it runs, its status.
  it('says its latest turn, as the pet card does', () => {
    const turn = {
      title: 'Brewing TypeScript refactor',
      ask: '可以开发了',
      tools: ['Read(a.ts)', 'Bash(sed -n 1,20p nodes/AgentAvatar.tsx)'],
      latest: { text: 'Brewing… (6m 5s)', tone: 'working' as const },
      pendingInput: null,
      tail: null
    }
    const html = renderToStaticMarkup(<AgentNode agent={agent({ phase: 'working', status: 'working', word: 'working', turn })} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('<b class="ag-title">Brewing TypeScript refactor</b>')
    expect(html).toContain('<em>You:</em> 可以开发了')
    // The newest tool only: the card has four lines.
    expect(html).toContain('Bash(sed -n 1,20p nodes/AgentAvatar.tsx)')
    expect(html).not.toContain('Read(a.ts)')
    expect(html).toContain('ag-now working')
    expect(html).not.toContain('push feat/route-core')
  })

  it('falls back to its one line when no turn is known', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent()} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('<span class="ag-now done">push feat/route-core')
  })

  // ONE CARD INSTANCE (owner, 2026-10-31): the pets draw no card of their own;
  // a pet's click opens this one (zoom-store · openCard).
  // ONE CARD (owner, 2026-11-01): in a full view the agent group floats THE
  // crew card — the same parts and the same AgentView — not a look-alike of its own.
  it('the agent group floats the crew card itself, from the same agent view', () => {
    const pets = readFileSync('src/renderer/src/pets/AgentPets.tsx', 'utf8')
    // Through AgentPetCard, which only swaps in the rows while a menu waits.
    expect(pets).toContain('<AgentPetCard')
    expect(readFileSync('src/renderer/src/pets/AgentPetCard.tsx', 'utf8')).toContain('<AgentCard')
    expect(pets).toContain('agent={agentViewOf(pet.row, attachIndex)}')
    expect(pets).not.toMatch(/<AgentLatest|<TurnView|function AgentCard/)
    const card = readFileSync('src/renderer/src/zoom/AgentCard.tsx', 'utf8')
    const node = readFileSync('src/renderer/src/zoom/ZoomParts.tsx', 'utf8')
    for (const shared of ['<CardBody agent={agent} sent={reply.sent}', 'useQuickReply(agent.id', '<QuickReply agent={agent} reply={reply}', 'status={agent.status} weight="large"']) {
      expect(card).toContain(shared)
      expect(node).toContain(shared)
    }
    // ONE LOOK (owner, 2026-11-01: "the two cards are still not the same"): the
    // floating card puts the parts where the painter puts them on the open
    // card, with the crew card's classes, and has no buttons of its own.
    const frame0 = readFileSync('src/renderer/src/zoom/zoom-frame.ts', 'utf8')
    expect(frame0).toContain('lerp(-e.nmW / 2, 30, nx), y: lerp(U.nameTop, -24, ny)')
    expect(frame0).toContain('lerp(stTop, -2, ny)')
    expect(frame0).toContain('const bodyCard = { x: -18, y: 32 + (1 - b) * 10 }')
    expect(frame0).toContain('const slot = { x: 17 + 79 * l.k, y: 136 }')
    expect(frame0).toContain('cx: lerp(0, -27, grow),')
    expect(frame0).toContain('cs: lerp(1, 0.45, grow)')
    expect(frame0).toContain('lerp(1, 0.62, ease(clamp01(zi - 1)))')
    expect(card).toContain('face: 0.62,')
    expect(card).toContain('name: { x: 30, y: -24 }')
    expect(card).toContain('meta: { x: 30, y: -2 }')
    expect(card).toContain('body: { x: -18, y: 32 }')
    expect(card).toContain('thumb: (k: number) => ({ x: 17 + 79 * k, y: 136 })')
    expect(card).toContain('coin: { x: -27, y: -18, s: 0.45 }')
    for (const cls of ['zv-av', 'zv-nm', 'zv-body', 'zv-lk', 'zv-th', 'zv-coin', 'zv-reply', 'zv-del']) expect(card).toContain(cls)
    expect(card).not.toContain('zv-emp')
    expect(card).not.toMatch(/className="cr-pet-card-open|className="cr-pet-card-x|\n\s*OPEN\n/)
    // The zoom card grew by the two lines it now says (zoom-frame.ts · the strip and the card).
    const frame = readFileSync('src/renderer/src/zoom/zoom-frame.ts', 'utf8')
    expect(frame).toContain('y: 136 }')
    expect(frame).toContain('64 / 244')
  })

  it('draws its card parts only when it is the open card, never once per agent behind the crew', () => {
    const closed = renderToStaticMarkup(<AgentNode agent={agent()} card={false} bind={bind} onOpen={() => undefined} />)
    expect(closed).toContain('Forge')
    expect(closed).not.toContain('zv-body')
    expect(closed).not.toContain('zv-reply')
    expect(closed).not.toContain('zv-emp')
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain('card={cardIds.has(a.id)}')
  })

  // Owner, 2026-11-03: "no browser or note" is not shown.
  it('says nothing when an agent carries nothing', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent({ browsers: 0, notes: 0 })} bind={bind} onOpen={() => undefined} />)
    expect(html).not.toContain('no browser or note')
    expect(html).not.toContain('zv-emp')
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

// A workspace's tile: zoom-workspace-tile.test.tsx.
describe('another machine of the account, on the devices stop', () => {
  const live: MachineView = { id: 'm2', name: 'Mac mini', local: false, online: true, detail: 'live', workspaces: [{ id: 'z', name: 'Home lab', presets: [], waiting: true }], agents: 3, waiting: 1 }

  it('is drawn as a machine, the way this one is: a frame, a screen with its workspaces on it, a base, its name under it', () => {
    const html = renderToStaticMarkup(<MachineNode machine={live} say={null} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('zv-machinecard-screen')
    expect(html).toContain('zv-machinecard-deck')
    expect(html).toContain('Mac mini')
    expect(html).toContain('Home lab')
    expect(html).toContain('1 workspace · 3 agents · 1 waiting')
    expect(html).toContain('data-read="true"')
  })

  it('one that is read and has no workspaces is still read: a lit, empty screen, not a dark one with nothing to do', () => {
    const empty: MachineView = { ...live, workspaces: [], agents: null, waiting: null }
    const html = renderToStaticMarkup(<MachineNode machine={empty} say={null} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('data-read="true"')
    expect(html).toContain('no workspaces')
    expect(html).toContain('0 workspaces')
  })

  it('one that cannot be read says the one thing to do, and never “listed only” or a zero it does not know', () => {
    const unread: MachineView = { ...live, detail: 'listed', agents: null, waiting: null }
    const html = renderToStaticMarkup(<MachineNode machine={unread} say="Prove it’s you on this Mac, below, to read it." bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('Prove it’s you on this Mac, below, to read it.')
    expect(html).not.toContain('listed only')
    expect(html).not.toContain('0 agents')
    expect(html).not.toContain('listed')
    // Its screen is dark: nothing of it is known to draw, not even what the registry last listed.
    expect(html).toContain('data-read="false"')
    expect(html).not.toContain('Home lab')
  })

  it('an offline one is dimmed and says so', () => {
    const off: MachineView = { ...live, online: false, detail: 'listed', agents: null, waiting: null }
    const html = renderToStaticMarkup(<MachineNode machine={off} say="Open Cookrew on Mac mini." bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('zv-machinecard off')
    expect(html).toContain('Open Cookrew on Mac mini.')
  })
})

describe('the zoom is driven by clicks, not the wheel (owner, 2026-10-31)', () => {
  const source = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
  // The wheel scrolls the thumbnails (owner, 2026-11-02): it is the page's and a list's, never the zoom's.
  // The shelf over them turns pages by its "+N" chip (owner, 2026-11-03), not by a sideways wheel.
  it('has no wheel zoom at all: the one wheel listener only scrolls, and lets a ctrl-pinch go', () => {
    expect(source.match(/addEventListener\('wheel'/g)).toHaveLength(1)
    const wheel = source.slice(source.indexOf('onWheel.current = (e) => {'), source.indexOf("addEventListener('wheel'"))
    expect(wheel).toContain('if (e.ctrlKey) return')
    expect(wheel).toContain('scrollBy(dy)')
    expect(wheel).not.toContain('shelf')
    expect(wheel).not.toMatch(/\.go\(|jumpTo|stepBack|stepOut|focusAgent|focusItem/)
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

describe('removing an agent (owner, 2026-10-31; making one is the global prompt now)', () => {
  it('a card carries its own way out, and only when it is asked for', () => {
    const without = renderToStaticMarkup(<AgentNode agent={agent()} bind={bind} onOpen={() => undefined} />)
    expect(without).not.toContain('zv-del')
    const withIt = renderToStaticMarkup(<AgentNode agent={agent()} bind={bind} onOpen={() => undefined} onDelete={() => undefined} />)
    expect(withIt).toContain('Remove Forge')
    const thumb = renderToStaticMarkup(<ItemNode item={item()} names={[]} bind={bind} onClick={() => undefined} onDelete={() => undefined} />)
    expect(thumb).toContain('Remove PR #82')
  })
})

// THE SHELF STACKS BY Z-INDEX (review, 2026-11-03): moving a keyed AgentNode
// in the DOM drops the focus of the reply box it holds, and changes which face
// lies on top in the workspace's pile and on the way into a full view.
describe('the shelf’s faces lie over each other without moving their nodes', () => {
  const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
  const motion = readFileSync('src/renderer/src/zoom/use-zoom-motion.ts', 'utf8')
  it('mounts the agents in the crew’s order', () => {
    expect(view).toContain('{model.agents.map((a) => <AgentNode')
    expect(view).not.toContain('shelfAgents')
  })
  it('stacks a shelf page by z-index, under the waiting dots', () => {
    expect(motion).toMatch(/shelfPage\(layout\.thumbs\.shelf/)
    expect(motion).toMatch(/rank !== undefined \? 10 \+ rank/)
    expect(Number(motion.match(/const SHELF_RANKS = (\d+)/)?.[1]) + 12).toBeLessThan(44)
  })
})
