// A CHUNK THAT IS NOT THERE ANY MORE IS A NEW BUILD (renderer/crash-report.ts,
// ErrorBoundary.tsx): recognised, reloaded once, never in a loop.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/api', () => ({ isRemoteMode: () => false, cookrew: () => ({}) }))
const { RELOAD_GUARD_MS, isChunkLoadError, reloadForNewBuild } = await import('../src/renderer/src/crash-report')
const { ErrorBoundary } = await import('../src/renderer/src/ErrorBoundary')

const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

describe('isChunkLoadError', () => {
  it('knows the sentences each browser uses for a missing chunk', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://cookrew.dev/relay/@drej/desktop/e039/assets/App-BCuRSkqK.js',
      'Importing a module script failed.',
      'error loading dynamically imported module: https://x/assets/a.js',
      'Unable to preload CSS for /assets/App.css'
    ]) {
      expect(isChunkLoadError(new TypeError(message)), message).toBe(true)
    }
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false)
  })
})

describe('reloadForNewBuild', () => {
  it('reloads once, and not again inside the guard', () => {
    const storage = memory()
    const reload = vi.fn()
    expect(reloadForNewBuild({ storage, now: 1_000_000, reload })).toBe(true)
    expect(reloadForNewBuild({ storage, now: 1_000_000 + RELOAD_GUARD_MS - 1, reload })).toBe(false)
    expect(reloadForNewBuild({ storage, now: 1_000_000 + RELOAD_GUARD_MS, reload })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
  it('without storage it never reloads, so it can never loop', () => {
    const reload = vi.fn()
    expect(reloadForNewBuild({ storage: null, now: 1, reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('ErrorBoundary on a missing chunk', () => {
  it('says Cookrew was updated, not that it crashed', () => {
    const boundary = new ErrorBoundary({ children: null })
    boundary.state = { error: new TypeError('Failed to fetch dynamically imported module: https://x/assets/App-old.js') }
    const html = renderToStaticMarkup(<>{boundary.render()}</>)
    expect(html).toContain('Cookrew was updated on the Mac')
    expect(html).not.toContain('hit an error')
  })
})
