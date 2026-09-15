import { describe, expect, it } from 'vitest'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML, BRAND_MARK_SVG, FAVICON_SVG } from '../registry/src/site-brand'
import { ASSETS } from '../registry/src/assets-bundle'
import { homePage, marketPage, marketQuery } from '../registry/src/site'

const input = { doors: [], presets: [], release: null, stars: () => 0, pulse: () => ({ opens: 0, lines: 0, callers: 0 }) as never, linesToday: 0, commits: null }

describe('the brand: the glove, its glasses, and KREW', () => {
  it('ships the glove as one bundled bitmap and the letters as outlines — no font, no data uri in the page', () => {
    expect(ASSETS['glove.png']?.type).toBe('image/png')
    expect(ASSETS['glove.png']?.encoding).toBe('base64')
    expect(BRAND_LOCKUP_HTML).toContain('/assets/glove.png?v=')
    expect(BRAND_LOCKUP_HTML).not.toContain('base64')
    expect(BRAND_LOCKUP_HTML).not.toContain('font-family')
    expect(BRAND_LOCKUP_HTML).toContain('paint-order="stroke fill"')
    expect(BRAND_LOCKUP_HTML).toContain('aria-label="COOKREW"')
  })

  it('the home page carries the lockup and no script; the market page does not carry it', () => {
    const home = homePage(input).body
    expect(home).toContain('class="brand"')
    expect(home).toContain(BRAND_LOCKUP_HTML)
    expect(home).not.toMatch(/<script(?![^>]*application\/ld\+json)/)
    expect(BRAND_LOCKUP_CSS).not.toContain('@keyframes')
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).not.toContain('class="brand"')
  })

  it('the header mark is the glove with its glasses, on every page', () => {
    const home = homePage(input).body
    expect(BRAND_MARK_SVG).toContain('class="mark-coo"')
    expect(home).toContain(BRAND_MARK_SVG)
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).toContain(BRAND_MARK_SVG)
  })

  it('the favicon stands alone: the glove inlined on an amber tile', () => {
    expect(FAVICON_SVG).toContain('<image href="data:image/png;base64,')
    expect(FAVICON_SVG).toContain('fill="#ffd600"')
    expect(FAVICON_SVG.startsWith('<svg xmlns=')).toBe(true)
  })
})
