// THE DOCK SPOKE FOR THE RETIRED CANVAS (Gauge, UI/UX QA, 2026-11-01): in the
// zoom view, the app's only view since 2026-10-30, TERMINAL armed a preset row
// that asked for "a click on the canvas", NOTE and BROWSER asked the same,
// and CONNECT and CLIPBOARD had nothing to act on. Wanted: every dock control
// does its job in the zoom view or is not shown there.
//
// Static markup, the house way (no jsdom; renderToStaticMarkup over a stubbed
// window, vi.resetModules and a dynamic import because api.ts reads
// module-scope globals once).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CanvasNode } from '../src/shared/model'
import { importTeam, makeAgent, makeItem, nextSpot } from '../src/renderer/src/zoom/make-card'
import { zoomStore } from '../src/renderer/src/zoom/zoom-store'
import { CANVAS_RETIRED } from '../src/renderer/src/canvas-ui'

const stubWindow = (): void => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

const dock = async () => {
  vi.resetModules()
  stubWindow()
  return import('../src/renderer/src/Dock')
}

const props = {
  tool: 'move' as const,
  onSelect: () => undefined,
  clipping: false,
  onToggleClipping: () => undefined,
  presets: ['Claude Code', 'Codex', 'Shell', 'my-team'],
  templates: ['my-team'],
  preset: 'Shell',
  onPreset: () => undefined,
  roles: [{ name: 'Reviewer', preset: 'Claude Code', prompt: 'review' }] as never[],
  role: null,
  onRole: () => undefined,
  orch: false,
  onOrch: () => undefined,
  connectHint: null,
  onMake: () => undefined,
  voiceFor: null,
  agents: [],
  nodes: [],
  browserFor: null,
  boardFor: null
}

/** The words a person can read: text between tags, plus every title and aria-label. */
const readable = (html: string): string =>
  [...html.matchAll(/>([^<]+)</g)].map((m) => m[1]).join(' ') +
  ' ' +
  [...html.matchAll(/(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1]).join(' ')

const node = (x: number, y: number, width: number, height: number): CanvasNode =>
  ({ kind: 'note', id: `n${x}`, name: 'n', customName: null, content: '', locked: false, position: { x, y }, size: { width, height } }) as CanvasNode

const resetZoom = (): void => {
  zoomStore.focusAgent(null)
  zoomStore.focusItem(null)
  zoomStore.go(-1, 'agents')
}

describe('the dock in the zoom view shows only what works there', () => {
  it('the canvas is retired, so the canvas-only controls are left out', async () => {
    expect(CANVAS_RETIRED).toBe(true)
    const { dockTools } = await dock()
    // NOTE and BROWSER are made inside an agent now (stage/AgentArtifacts.tsx).
    expect(dockTools(true).map((t) => t.label)).toEqual(['TERMINAL'])
    // A canvas brought back gets CONNECT back, nothing else changes.
    expect(dockTools(false).map((t) => t.label)).toEqual(['TERMINAL', 'NOTE', 'BROWSER', 'CONNECT'])
    // The first test imports the dock's whole tree, cold.
  }, 20_000)

  it('renders no CONNECT, no CLIPBOARD, no NOTE and no BROWSER, and keeps TERMINAL', async () => {
    const { Dock } = await dock()
    const html = renderToStaticMarkup(<Dock {...props} />)
    for (const label of ['CONNECT', 'CLIPBOARD', 'NOTE', 'BROWSER']) expect(html).not.toContain(`aria-label="${label}"`)
    expect(html).toContain('aria-label="TERMINAL"')
  })

  it('no hint, title or label speaks of a canvas, whichever tool is up', async () => {
    const { Dock } = await dock()
    for (const tool of ['move', 'terminal', 'note', 'browser'] as const) {
      expect(readable(renderToStaticMarkup(<Dock {...props} tool={tool} />))).not.toMatch(/canvas/i)
    }
    // The board view's toggle, the dock's other occupant, too.
    const board = renderToStaticMarkup(<Dock {...props} boardFor={{ editing: false, onToggle: () => undefined }} />)
    expect(readable(board)).not.toMatch(/canvas/i)
  })

  it('TERMINAL opens the preset row with a hint that a pick makes the agent now', async () => {
    const { Dock } = await dock()
    const html = renderToStaticMarkup(<Dock {...props} tool="terminal" />)
    expect(html).toContain('PICK ONE TO ADD IT HERE NOW')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Reviewer')
    expect(html).toContain('my-team')
  })

  it('while a card is being made, the chips hold still', async () => {
    const { Dock } = await dock()
    // The global prompt's own send waits for words; it is not one of the tools.
    const tools = (html: string): string => html.replace(/<form class="cr-prompt[\s\S]*?<\/form>/, '')
    const idle = tools(renderToStaticMarkup(<Dock {...props} tool="terminal" />))
    expect(idle).not.toContain('disabled=""')
    const busy = tools(renderToStaticMarkup(<Dock {...props} tool="terminal" making />))
    // 3 harnesses + 1 role + 1 team; TERMINAL stays pressable to close the row.
    expect(busy.match(/disabled=""/g)?.length).toBe(5)
  })

  it('a card that could not be made says why, where the hint was', async () => {
    const { Dock } = await dock()
    const html = renderToStaticMarkup(<Dock {...props} tool="terminal" makeError="That agent could not be made: boom" />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('That agent could not be made: boom')
    expect(html).not.toContain('PICK ONE TO ADD IT HERE NOW')
    // An error with no tool up still shows.
    expect(renderToStaticMarkup(<Dock {...props} makeError="That note could not be made: x" />)).toContain('That note could not be made: x')
  })
})

describe('a dock pick makes the agent at once, on the crew seat path', () => {
  beforeEach(resetZoom)

  it('creates the agent in the active workspace and opens its card in the crew', async () => {
    const calls: unknown[] = []
    const api = { createTerminal: async (opts: unknown) => (calls.push(opts), { id: 't-new' }) as CanvasNode }
    const made = await makeAgent(api, { name: 'Codex', preset: 'Codex', orch: true }, [node(0, 0, 300, 200)])
    expect(made).toEqual({ ok: true, id: 't-new' })
    expect(calls).toEqual([{ name: 'Codex', preset: 'Codex', orch: true, position: { x: 360, y: 0 } }])
    const z = zoomStore.get()
    expect([z.dir, z.v, z.agent]).toEqual(['agents', 2, 't-new'])
  })

  it('a role boots its preset with the role name', async () => {
    const calls: unknown[] = []
    const api = { createTerminal: async (opts: unknown) => (calls.push(opts), { id: 't-r' }) as CanvasNode }
    await makeAgent(api, { name: 'Reviewer', preset: 'Claude Code', roleName: 'Reviewer', orch: false })
    expect(calls[0]).toMatchObject({ name: 'Reviewer', preset: 'Claude Code', roleName: 'Reviewer', orch: false })
  })

  it('a failure is an answer to show, not a throw, and the zoom stays put', async () => {
    const api = { createTerminal: async () => Promise.reject(new Error('no herdr')) }
    const made = await makeAgent(api, { name: 'Codex', preset: 'Codex', orch: false })
    expect(made).toEqual({ ok: false, error: 'That agent could not be made: Error: no herdr' })
    expect(zoomStore.get().agent).toBeNull()
    expect(await makeAgent({}, { name: 'x', preset: 'x', orch: false })).toEqual({ ok: false, error: 'This build cannot create an agent.' })
  })

  it('a saved team opens its session at once, with no canvas point', async () => {
    const calls: unknown[][] = []
    const api = { templateImport: async (...args: unknown[]) => (calls.push(args), {}) as never }
    expect(await importTeam(api, 'my-team')).toEqual({ ok: true, id: null })
    expect(calls).toEqual([['my-team']])
  })
})

describe('NOTE and BROWSER make their card at once', () => {
  beforeEach(resetZoom)

  it.each(['note', 'browser'] as const)('a %s lands beside the rest and the thumbnails open on it', async (kind) => {
    const added: CanvasNode[] = []
    const api = { addNode: async (n: CanvasNode) => (added.push(n), n) }
    const made = await makeItem(api, kind, [node(0, 40, 300, 200)])
    expect(added).toHaveLength(1)
    expect(added[0].kind).toBe(kind)
    expect(added[0].position).toEqual({ x: 360, y: 40 })
    expect(made).toEqual({ ok: true, id: added[0].id })
    const z = zoomStore.get()
    expect([z.dir, z.v, z.item]).toEqual(['items', 0, added[0].id])
  })

  it('a failure says which card could not be made', async () => {
    const api = { addNode: async () => Promise.reject(new Error('disk')) }
    expect(await makeItem(api, 'browser')).toEqual({ ok: false, error: 'That browser could not be made: Error: disk' })
  })
})

describe('where a made card is stored', () => {
  it('an empty workspace starts at the origin; otherwise right of everything, on the grid', () => {
    expect(nextSpot([])).toEqual({ x: 0, y: 0 })
    expect(nextSpot([node(0, 0, 300, 200), node(500, 90, 100, 100)])).toEqual({ x: 640, y: 0 })
    expect(nextSpot([node(-50, 130, 10, 10)])).toEqual({ x: 0, y: 160 })
  })
})

describe('one way to make a card', () => {
  const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

  it('the global prompt and the dock both go through make-card, and the pane-click placement is gone', () => {
    // The crew's ＋ seat gave way to the global prompt (owner, 2026-11-01).
    const prompt = src('src/renderer/src/prompt/GlobalPrompt.tsx')
    expect(prompt).toContain("from '../zoom/make-card'")
    expect(prompt).not.toContain('createTerminal(')
    expect(src('src/renderer/src/zoom/ZoomView.tsx')).not.toContain('createTerminal(')
    const app = src('src/renderer/src/App.tsx')
    expect(app).toContain("from './zoom/make-card'")
    expect(app).not.toContain('onPaneClick')
    expect(app).toMatch(/onMake=\{\(kind\) => void make\(\(\) => makeItem\(/)
  })
})

describe('a note or a browser is made inside an agent (owner, 2026-11-01)', () => {
  it('is wired to the agent, named after it under a name the workspace does not have', async () => {
    const { makeItemFor, freeName } = await import('../src/renderer/src/zoom/make-card')
    expect(freeName('Forge note', ['forge note', 'Forge note 2'])).toBe('Forge note 3')
    expect(freeName('Forge browser', [])).toBe('Forge browser')
    const added: CanvasNode[] = []
    const wires: [string, string][] = []
    const api = {
      addNode: async (node: CanvasNode) => (added.push(node), node),
      connectNodes: async (a: string, b: string) => (wires.push([a, b]), { id: 'c1', a, b })
    }
    const made = await makeItemFor(api as never, 'note', { id: 't1', name: 'Forge' }, [node(0, 0, 10, 10)])
    expect(made.ok).toBe(true)
    expect(added[0]).toMatchObject({ kind: 'note', name: 'Forge note' })
    expect(wires).toEqual([['t1', added[0].id]])
  })

  it('says so when the wire fails, and never navigates away from the agent', async () => {
    const { makeItemFor } = await import('../src/renderer/src/zoom/make-card')
    const { zoomStore } = await import('../src/renderer/src/zoom/zoom-store')
    const before = zoomStore.get()
    const api = { addNode: async (node: CanvasNode) => node, connectNodes: async () => { throw new Error('nope') } }
    const made = await makeItemFor(api as never, 'browser', { id: 't1', name: 'Forge' })
    expect(made).toEqual({ ok: false, error: 'The browser was made but could not be given to Forge: Error: nope' })
    expect(zoomStore.get()).toEqual(before)
  })

  it("the agent's full view carries the column, and the left troop stays off beside it", () => {
    const stage = readFileSync('src/renderer/src/stage/StageView.tsx', 'utf8')
    expect(stage).toMatch(/<AgentArtifacts/)
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(app).toMatch(/\(zoomFull === 'item' \|\| view !== 'stage'\) && <ItemPets/)
  })
})
