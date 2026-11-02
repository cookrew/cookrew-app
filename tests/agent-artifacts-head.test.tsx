// THE AGENT'S ARTIFACTS (owner, 2026-11-03): on the agent's sheet the column of
// browsers and notes is headed "artifacts", the head hides and shows the
// thumbnails (remembered across agents and restarts), and an agent with none
// shows no column and says nothing: no "no browser or note" anywhere.
//
// Static markup, the house way (no DOM env).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserNodeData, CanvasNode } from '../src/shared/model'

const stubWindow = (seed: Record<string, string> = {}): void => {
  const store = new Map<string, string>(Object.entries(seed))
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

/** A cold import of the sheet's whole tree: slow on a loaded machine, not wrong. */
const COLD_MS = 30_000

const load = async (seed?: Record<string, string>) => {
  vi.resetModules()
  stubWindow(seed)
  const arts = await import('../src/renderer/src/stage/AgentArtifacts')
  const ui = await import('../src/renderer/src/canvas-ui')
  const shown = await import('../src/renderer/src/stage/artifacts-shown')
  return { ...arts, ...ui, ...shown }
}

const browser = (id: string, url: string, title: string): BrowserNodeData =>
  ({ kind: 'browser', id, name: title, url, tabs: [{ id: `${id}:t`, url, title }], activeTabId: `${id}:t`, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as BrowserNodeData

const render = async (opts: { empty?: boolean; seed?: Record<string, string> } = {}): Promise<string> => {
  const { AgentArtifacts, CanvasUiContext } = await load(opts.seed)
  const pr = browser('b1', 'https://github.com/cookrew/x', 'PR #82')
  const ui = { requestClose: () => undefined } as unknown as React.ContextType<typeof CanvasUiContext>
  return renderToStaticMarkup(
    <CanvasUiContext.Provider value={ui}>
      <AgentArtifacts
        agent={{ id: 't1', name: 'Forge' }}
        items={opts.empty ? [] : [{ kind: 'browser', node: pr }]}
        owners={new Map([['b1', ['t1']]])}
        nodes={[pr] as CanvasNode[]}
      />
    </CanvasUiContext.Provider>
  )
}

describe("the agent's artifacts column", () => {
  it('is headed "artifacts" with its count, a toggle that starts open', async () => {
    const html = await render()
    expect(html).toMatch(/<button[^>]*class="zv-fv-arts-toggle"[^>]*aria-expanded="true"/)
    expect(html).toContain('>artifacts<')
    expect(html).toMatch(/class="zv-fv-arts-n"[^>]*>1</)
    expect(html).not.toContain('browsers &amp; notes')
    expect(html).toContain('zv-fv-arts-list')
  }, COLD_MS)

  it('hidden, keeps its head and drops the thumbnails', async () => {
    const html = await render({ seed: { 'cookrew.fv.artifacts': 'hidden' } })
    expect(html).toMatch(/<aside class="zv-fv-arts hidden"/)
    expect(html).toMatch(/aria-expanded="false"/)
    expect(html).not.toContain('zv-fv-arts-list')
    expect(html).not.toContain('PR #82')
  }, COLD_MS)

  it('with none, says nothing: no label, no list', async () => {
    const html = await render({ empty: true })
    expect(html).not.toContain('no browser or note')
    expect(html).not.toContain('zv-fv-arts-toggle')
    expect(html).not.toContain('zv-fv-arts-list')
    // Without a head slot the make buttons still need a place to stand.
    expect(html).toContain('aria-label="New note for Forge"')
  }, COLD_MS)

  it('with none and the head holding the make buttons, draws no column at all', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/stage/AgentArtifacts.tsx'), 'utf8')
    expect(src).toMatch(/if \(views\.length === 0 && makeSlot\)/)
  })
})

describe('the shown/hidden memory', () => {
  it('flips, persists, and reads back', async () => {
    const { artifactsShown } = await load()
    expect(artifactsShown.get()).toBe(true)
    artifactsShown.toggle()
    expect(artifactsShown.get()).toBe(false)
    expect(localStorage.getItem('cookrew.fv.artifacts')).toBe('hidden')
    artifactsShown.toggle()
    expect(artifactsShown.get()).toBe(true)
    expect(localStorage.getItem('cookrew.fv.artifacts')).toBeNull()
  }, COLD_MS)
})

describe('nowhere says "no browser or note"', () => {
  it('the zoom card and the floating card drop the empty line', () => {
    for (const file of ['zoom/ZoomParts.tsx', 'zoom/AgentCard.tsx', 'stage/AgentArtifacts.tsx']) {
      const src = readFileSync(join(__dirname, '../src/renderer/src', file), 'utf8')
      expect(src, file).not.toContain('no browser or note')
    }
  })
})
