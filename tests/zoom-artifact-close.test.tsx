// AN ARTIFACT CLOSES AS AN AGENT DOES (owner, 2026-11-01): the browsers and
// notes on an agent's sheet (stage/AgentArtifacts.tsx) get the same small ×
// the agent's card wears (ZoomParts · AgentNode, zoom/AgentCard.tsx), and it
// goes through the same door: CanvasUi.requestClose, so the app's one confirm
// dialog asks before anything is removed.
//
// Static markup, the house way (no DOM env); the thumbnail is a plain
// function component, so its element tree is read and pressed directly.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserNodeData, CanvasNode, NoteNodeData } from '../src/shared/model'
import type { ItemView } from '../src/renderer/src/zoom/zoom-model'

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

const load = async () => {
  vi.resetModules()
  stubWindow()
  const arts = await import('../src/renderer/src/stage/AgentArtifacts')
  const ui = await import('../src/renderer/src/canvas-ui')
  return { ...arts, ...ui }
}

const browser = (id: string, url: string, title: string): BrowserNodeData =>
  ({ kind: 'browser', id, name: title, url, tabs: [{ id: `${id}:t`, url, title }], activeTabId: `${id}:t`, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as BrowserNodeData
const note = (id: string, name: string, content: string): NoteNodeData =>
  ({ kind: 'note', id, name, customName: name, content, locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as NoteNodeData

const view = (over: Partial<ItemView> = {}): ItemView => ({
  id: 'b1', kind: 'browser', title: 'PR #82', host: 'github.com/cookrew', tint: '#5d6b7a', initial: 'P',
  line: 'https://github.com/cookrew/x', owners: ['t1'], ...over
})

/** Every element in a tree, depth first. */
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const el = node as ReactElement<Record<string, unknown>>
  return [el, ...elements(el.props.children as ReactNode)]
}

describe("an artifact on the agent's sheet has a ×, as the agent has", () => {
  it('each browser and note wears a remove mark, never nested inside its thumbnail button', async () => {
    const { AgentArtifacts, CanvasUiContext } = await load()
    const pr = browser('b1', 'https://github.com/cookrew/x', 'PR #82')
    const plan = note('n1', 'Plan', 'ship it')
    const ui = { requestClose: () => undefined } as unknown as React.ContextType<typeof CanvasUiContext>
    const html = renderToStaticMarkup(
      <CanvasUiContext.Provider value={ui}>
        <AgentArtifacts
          agent={{ id: 't1', name: 'Forge' }}
          items={[{ kind: 'browser', node: pr }, { kind: 'note', node: plan }]}
          owners={new Map([['b1', ['t1']], ['n1', ['t1']]])}
          nodes={[pr, plan] as CanvasNode[]}
        />
      </CanvasUiContext.Provider>
    )
    expect(html).toContain('aria-label="Remove PR #82"')
    expect(html).toContain('aria-label="Remove Plan"')
    expect(html.match(/class="zv-del zv-fv-art-del"/g)).toHaveLength(2)
    // A button inside a button is invalid HTML: the × sits beside the thumbnail.
    expect(html).not.toMatch(/<button[^>]*class="zv-fv-art[ "][^>]*>(?:(?!<\/button>).)*<button/s)
  })

  it('the × asks to remove that card and does not also open it', async () => {
    const { ArtifactThumb } = await load()
    const onRemove = vi.fn()
    const onOpen = vi.fn()
    const tree = ArtifactThumb({ view: view(), on: false, onOpen, onRemove })
    const mark = elements(tree).find((el) => el.props['aria-label'] === 'Remove PR #82')
    expect(mark).toBeDefined()
    const stopPropagation = vi.fn()
    ;(mark!.props.onClick as (e: unknown) => void)({ stopPropagation })
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a shared card says the others lose it too, before the dialog does', async () => {
    const { ArtifactThumb } = await load()
    const tree = ArtifactThumb({ view: view({ owners: ['t1', 't2', 't3'] }), on: false, onOpen: () => undefined, onRemove: () => undefined })
    const mark = elements(tree).find((el) => el.props['aria-label'] === 'Remove PR #82')
    expect(mark?.props.title).toBe('Remove PR #82 — 3 agents use it')
  })

  it('it goes through CanvasUi.requestClose, the one confirm dialog, never removeNode', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/stage/AgentArtifacts.tsx'), 'utf8')
    expect(src).toMatch(/useCanvasUi\(\)/)
    expect(src).toMatch(/requestClose\(view\.id\)/)
    expect(src).not.toMatch(/removeNode/)
  })
})
