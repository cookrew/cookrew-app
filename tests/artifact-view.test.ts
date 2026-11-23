// AN ARTIFACT READ FOR A DEVICE (main/artifact-view.ts): what a phone may draw
// itself instead of streaming the screen. The confinement is the point — a card
// may only hand over files its own workspace holds.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_MAX_BYTES, artifactView } from '../src/main/artifact-view'
import type { BrowserNodeData, NoteNodeData, WorkspaceState } from '../src/shared/model'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): { root: string; state: WorkspaceState; file: (name: string, body: string) => string } {
  const root = mkdtempSync(path.join(tmpdir(), 'artifact-view-'))
  dirs.push(root)
  const state: WorkspaceState = { name: 'W', dir: root, dirs: [root], nodes: [], connections: [] }
  return {
    root,
    state,
    file: (name, body) => {
      const at = path.join(root, name)
      mkdirSync(path.dirname(at), { recursive: true })
      writeFileSync(at, body)
      return at
    }
  }
}

function note(id: string, content: string): NoteNodeData {
  return {
    kind: 'note', id, name: id, customName: null, content, locked: false,
    position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }
}

function browser(id: string, url: string): BrowserNodeData {
  return {
    kind: 'browser', id, name: id, url,
    tabs: [{ id: `${id}-tab`, url, title: '' }], activeTabId: `${id}-tab`,
    position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }
}

describe('a note', () => {
  it('travels as its markdown, titled by its first line', () => {
    const { state } = workspace()
    state.nodes.push(note('n1', '# Report\n\nbody'))
    const view = artifactView(state, 'n1')
    expect(view).toEqual({ kind: 'note', name: 'n1', title: 'Report', markdown: '# Report\n\nbody' })
  })

  it('is refused rather than truncated when it is too large to render', () => {
    const { state } = workspace()
    state.nodes.push(note('n1', 'x'.repeat(3 * 1024 * 1024)))
    expect(artifactView(state, 'n1')).toMatchObject({ kind: 'unavailable' })
  })
})

describe('a file card', () => {
  it('hands over a file inside the workspace, with its type and a hash', () => {
    const { state, file } = workspace()
    const at = file('report.html', '<h1>done</h1>')
    state.nodes.push(browser('b1', `file://${at}`))
    const view = artifactView(state, 'b1')
    expect(view).toMatchObject({ kind: 'file', mime: 'text/html; charset=utf-8' })
    if (view?.kind !== 'file') throw new Error('not a file view')
    expect(view.bytes.toString()).toBe('<h1>done</h1>')
    expect(view.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a file outside every workspace directory', () => {
    const { state } = workspace()
    state.nodes.push(browser('b1', 'file:///etc/hosts'))
    expect(artifactView(state, 'b1')).toMatchObject({ kind: 'unavailable' })
  })

  it('refuses a link inside the workspace that points outside it', () => {
    const { state, root } = workspace()
    const link = path.join(root, 'escape')
    symlinkSync('/etc/hosts', link)
    state.nodes.push(browser('b1', `file://${link}`))
    expect(artifactView(state, 'b1')).toMatchObject({ kind: 'unavailable' })
  })

  it('refuses a file larger than the cap instead of sending it', () => {
    const { state, file } = workspace()
    const at = file('big.bin', 'small')
    state.nodes.push(browser('b1', `file://${at}`))
    const view = artifactView(state, 'b1', { stat: () => ({ size: ARTIFACT_MAX_BYTES + 1, isFile: () => true }) })
    expect(view).toMatchObject({ kind: 'unavailable' })
  })

  it('says a missing file is gone, and that a directory is not a file', () => {
    const { state, root } = workspace()
    state.nodes.push(browser('gone', `file://${path.join(root, 'nope.html')}`))
    state.nodes.push(browser('dir', `file://${root}`))
    expect(artifactView(state, 'gone')).toMatchObject({ kind: 'unavailable' })
    expect(artifactView(state, 'dir')).toMatchObject({ kind: 'unavailable' })
  })

  it('hands a web page over as a link the device opens itself', () => {
    const { state } = workspace()
    state.nodes.push(browser('b2', 'https://example.com/report'))
    expect(artifactView(state, 'b2')).toEqual({ kind: 'link', name: 'b2', url: 'https://example.com/report' })
  })

  it('refuses a card that is showing nothing addressable', () => {
    const { state } = workspace()
    state.nodes.push(browser('b3', 'about:blank'))
    expect(artifactView(state, 'b3')).toMatchObject({ kind: 'unavailable' })
  })
})

describe('the card id', () => {
  it('is looked up in this workspace only', () => {
    const { state } = workspace()
    expect(artifactView(state, 'nope')).toBeNull()
  })
})
