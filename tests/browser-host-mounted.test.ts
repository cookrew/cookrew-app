// THE BROWSER HOST IS ALWAYS MOUNTED (owner, 2026-10-31: "the browser does not
// show"). Browser pages live in BrowserLayer and are drawn at the slot a stage
// pane or a terminal's lower half measures. It used to ride inside the canvas's
// LodOverlays; retiring the canvas unmounted it and every slot stayed empty.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

describe('App mounts the browser host', () => {
  it('renders BrowserLayer with the workspace browsers', () => {
    const at = app.indexOf('<BrowserLayer')
    expect(at).toBeGreaterThan(0)
    expect(app.slice(at, at + 300)).toContain('browsers={browsers}')
  })

  it('renders it for every view, not only one', () => {
    const at = app.indexOf('<BrowserLayer')
    // The nearest JSX expression opener before it is not a view condition.
    const before = app.slice(Math.max(0, at - 600), at)
    expect(before).not.toMatch(/\{view === '[a-z]+' && \([^)]*$/)
  })
})
