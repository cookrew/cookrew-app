// THE CRASH SCREEN AND WHAT IT LEAVES BEHIND (renderer/ErrorBoundary.tsx,
// renderer/crash-report.ts). The canvas is retired, so the screen no longer
// names it; its first button reloads the page instead of re-rendering the
// tree that just threw; and the report carries the error, its stack and the
// component trail — with the path only, never the token in the query.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/api', () => ({ isRemoteMode: () => false, cookrew: () => ({}) }))
const { crashReport } = await import('../src/renderer/src/crash-report')
const { ErrorBoundary } = await import('../src/renderer/src/ErrorBoundary')

describe('crashReport', () => {
  it('carries the message, the stack and the component trail, bounded', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'x')")
    const report = crashReport(error, '\n    at PetTroop\n    at AgentPets\n    at App', '/', 7)
    expect(report).toMatchObject({ crash: true, message: error.message, path: '/', t: 7 })
    expect(report.stack).toContain('TypeError')
    expect(report.component.startsWith('at PetTroop')).toBe(true)
    expect(crashReport(new Error('x'), 'y'.repeat(10_000), '/', 0).component).toHaveLength(4000)
  })

  it('reads a thrown non-Error too', () => {
    expect(crashReport('boom', null, '/', 0)).toMatchObject({ message: 'boom', component: '' })
  })
})

describe('ErrorBoundary', () => {
  it('no longer says canvas, shows what broke, and offers a reload', () => {
    const boundary = new ErrorBoundary({ children: null })
    boundary.state = { error: new Error('pets exploded') }
    const html = renderToStaticMarkup(<>{boundary.render()}</>)
    expect(html).not.toMatch(/canvas/i)
    expect(html).toContain('Cookrew hit an error')
    expect(html).toContain('pets exploded')
    expect(html).toContain('>Reload<')
    expect(html).toContain('>Try again<')
  })
})
