// THE VIEW'S TOOLBAR (owner 2026-11-12): "remote desktop takes too much room:
// one icon in the top right, one toolbar with per row, the same as the
// artifacts toolbar in an agent's full view, and in every view of a workspace."
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalMachine } from '../src/renderer/src/zoom/ZoomParts'

type Props = { children?: ReactNode; onClick?: (e: unknown) => void; className?: string }
const elements = (node: ReactNode): ReactElement<Props>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Props>(node)) return []
  return [node, ...elements(node.props.children)]
}

const withSources = (on: boolean): void => {
  ;(globalThis as Record<string, unknown>).window = { cookrew: on ? { useSources: async () => ({ ok: true, sources: [] }) } : {} }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.resetModules()
})

describe('this machine on the devices stop', () => {
  it('is its frame, its name and counts; no remote desktop button of its own any more', () => {
    const onOpen = vi.fn()
    const tree = LocalMachine({ name: 'Studio', detail: '3 workspaces · 9 agents', bind: () => () => undefined, onOpen })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('Studio')
    expect(html).toContain('3 workspaces · 9 agents')
    expect(html).not.toContain('Remote desktop')
    elements(tree)[0].props.onClick?.({})
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe('ViewTools', () => {
  it('per row and remote desktop on one bar, in the full view’s own buttons', async () => {
    withSources(true)
    const { ViewTools } = await import('../src/renderer/src/zoom/ViewTools')
    const html = renderToStaticMarkup(<ViewTools perRow={{ what: 'agents', narrow: false, cols: 4, onPick: () => undefined }} />)
    expect(html).toMatch(/^<div class="zv-view-tools" role="toolbar"/)
    expect(html).toContain('aria-label="Agents per row"')
    expect(html).toMatch(/class="zv-fv-arts-btn" aria-pressed="true"[^>]*aria-label="4 agents per row"/)
    expect(html).toContain('class="zv-fv-arts-btn zv-tool-desk"')
    expect(html).toContain('aria-label="Remote desktop"')
  })

  it('where no row is seen, the remote desktop alone; where the screen cannot be shared (a phone, the console), the per row alone or nothing', async () => {
    withSources(true)
    let tools = await import('../src/renderer/src/zoom/ViewTools')
    expect(renderToStaticMarkup(<tools.ViewTools />)).toContain('Remote desktop')
    expect(renderToStaticMarkup(<tools.ViewTools />)).not.toContain('per row')
    vi.resetModules()
    withSources(false)
    tools = await import('../src/renderer/src/zoom/ViewTools')
    expect(renderToStaticMarkup(<tools.ViewTools />)).toBe('')
    const rows = renderToStaticMarkup(<tools.ViewTools perRow={{ what: 'workspaces', narrow: true, cols: 2, onPick: () => undefined }} />)
    expect(rows).toContain('Workspaces per row')
    expect(rows).not.toContain('Remote desktop')
  })

  it('stands at every stop of this machine, and the agent’s full view carries the same button', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain('{!zoom.full && inside === null && <ViewTools perRow={perRowAt} />}')
    expect(view).not.toContain('PerRowPill')
    const stage = readFileSync('src/renderer/src/stage/StageView.tsx', 'utf8')
    expect(stage).toMatch(/<span className="zv-fv-tools">[\s\S]*?<RemoteDeskButton \/>\s*<\/span>/)
  })
})
