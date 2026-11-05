// ONE WORD FOR WHO RAN THE PAGE: a Home Screen web app, or a browser tab.
import { describe, expect, it } from 'vitest'
import { pageContextOf } from '../src/renderer/src/path/page-context'

describe('pageContextOf', () => {
  it('iOS says standalone through navigator.standalone', () => {
    expect(pageContextOf({ standalone: true })).toBe('standalone')
  })
  it('an app installed full screen is a web app too, whichever display mode the manifest picked', () => {
    const fullscreen = (q: string): { matches: boolean } => ({ matches: q === '(display-mode: fullscreen)' })
    expect(pageContextOf({ matchMedia: fullscreen })).toBe('standalone')
  })

  it('a browser tab in the Fullscreen API matches that query and is still a browser', () => {
    const fullscreen = (q: string): { matches: boolean } => ({ matches: q === '(display-mode: fullscreen)' })
    expect(pageContextOf({ matchMedia: fullscreen, elementFullscreen: true })).toBe('browser')
  })

  it('the standard says it through display-mode', () => {
    expect(pageContextOf({ matchMedia: () => ({ matches: true }) })).toBe('standalone')
  })
  it('anything else is a browser, including a page with no media queries', () => {
    expect(pageContextOf({ standalone: false, matchMedia: () => ({ matches: false }) })).toBe('browser')
    expect(pageContextOf({})).toBe('browser')
    expect(
      pageContextOf({
        matchMedia: () => {
          throw new Error('no')
        }
      })
    ).toBe('browser')
  })
})
