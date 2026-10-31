import { describe, expect, it } from 'vitest'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML, BRAND_MARK_SVG, FAVICON_SVG } from '../registry/src/site-brand'
import { ASSETS } from '../registry/src/assets-bundle'
import { homePage, marketPage, marketQuery } from '../registry/src/site'

const input = { doors: [], presets: [], release: null, stars: () => 0, pulse: () => ({ opens: 0, lines: 0, callers: 0 }) as never, linesToday: 0, commits: null }

describe('the brand: COOkrew in ink, one brush C round the first lens', () => {
  it('ships the lockup as static brush paths — no bitmap, no font, no data uri in the page', () => {
    expect(ASSETS['glove.png']).toBeUndefined()
    expect(BRAND_LOCKUP_HTML).toContain('class="cr-ink-lockup"')
    expect(BRAND_LOCKUP_HTML).toContain('aria-label="COOKREW"')
    expect(BRAND_LOCKUP_HTML).not.toContain('<image')
    expect(BRAND_LOCKUP_HTML).not.toContain('base64')
    expect(BRAND_LOCKUP_HTML).not.toContain('font-family')
    // three strokes in the order the brush wrote them: the C, the glasses, krew
    expect(BRAND_LOCKUP_HTML.match(/class="ink-draw ink-draw-\d"/g)).toEqual(['class="ink-draw ink-draw-0"', 'class="ink-draw ink-draw-1"', 'class="ink-draw ink-draw-2"'])
  })

  it('draws itself on in CSS alone, and holds still for reduced motion', () => {
    expect(BRAND_LOCKUP_CSS).toContain('@keyframes ink-draw')
    expect(BRAND_LOCKUP_CSS).toContain('.ink-draw-2{animation-duration:1.5s;animation-delay:2.25s}')
    expect(BRAND_LOCKUP_CSS).toContain('prefers-reduced-motion')
  })

  it('the home page carries the lockup and no script; the market page does not carry it', () => {
    const home = homePage(input).body
    expect(home).toContain('class="brand"')
    expect(home).toContain(BRAND_LOCKUP_HTML)
    expect(home).not.toMatch(/<script(?![^>]*application\/ld\+json)/)
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).not.toContain('class="brand"')
  })

  it('the header mark is the whole lockup, still, in the ink colour, on every page', () => {
    const home = homePage(input).body
    expect(BRAND_MARK_SVG).toContain('class="mark-coo"')
    expect(BRAND_MARK_SVG).toContain('fill="currentColor"')
    expect(BRAND_MARK_SVG).not.toContain('ink-draw')
    expect(home).toContain(`<a class="mark" href="/" aria-label="Cookrew home">${BRAND_MARK_SVG}</a>`)
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).toContain(BRAND_MARK_SVG)
  })

  it('the favicon stands alone: the C round one lens on a paper tile', () => {
    expect(FAVICON_SVG.startsWith('<svg xmlns=')).toBe(true)
    expect(FAVICON_SVG).toContain('fill="#f4efe4"')
    expect(FAVICON_SVG).not.toContain('<image')
  })
})
