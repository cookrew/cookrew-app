import { describe, expect, it } from 'vitest'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML, BRAND_MARK_SVG, FAVICON_SVG } from '../registry/src/site-brand'
import { ASSETS } from '../registry/src/assets-bundle'
import { homePage, marketPage, marketQuery } from '../registry/src/site'

const input = { doors: [], presets: [], release: null, stars: () => 0, pulse: () => ({ opens: 0, lines: 0, callers: 0 }) as never, linesToday: 0, commits: null }

describe('the brand: the icon, and COOKREW as seven pixel letters', () => {
  it('ships the glove as one bundled bitmap and the letters as paths — no font, no data uri in the page', () => {
    expect(ASSETS['glove.png']?.type).toBe('image/png')
    expect(ASSETS['glove.png']?.encoding).toBe('base64')
    expect(BRAND_LOCKUP_HTML).toContain('/assets/glove.png?v=')
    expect(BRAND_LOCKUP_HTML).not.toContain('base64')
    expect(BRAND_LOCKUP_HTML).not.toContain('font-family')
    expect(BRAND_LOCKUP_HTML).toContain('aria-label="COOKREW"')
    // seven letters, one ink: six still letters and the W, nothing coloured apart
    expect(BRAND_LOCKUP_HTML.match(/class="l l\d"/g)?.length).toBe(12)
    expect(BRAND_LOCKUP_HTML).not.toContain('amber-deep')
  })

  it('the W plays the tank and the pac-man in turn, in CSS alone', () => {
    expect(BRAND_LOCKUP_CSS).toContain('@keyframes tk-walk')
    expect(BRAND_LOCKUP_CSS).toContain('@keyframes pm-jl')
    expect(BRAND_LOCKUP_CSS).toContain('@keyframes brand-a')
    expect(BRAND_LOCKUP_CSS).toContain('prefers-reduced-motion')
    expect(BRAND_LOCKUP_HTML).toContain('class="cr-lockup lk lk-a tk"')
    expect(BRAND_LOCKUP_HTML).toContain('class="cr-lockup lk lk-b pm"')
  })

  it('the home page carries the lockup and no script; the market page does not carry it', () => {
    const home = homePage(input).body
    expect(home).toContain('class="brand"')
    expect(home).toContain(BRAND_LOCKUP_HTML)
    expect(home).not.toMatch(/<script(?![^>]*application\/ld\+json)/)
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).not.toContain('class="brand"')
  })

  it('the header mark is the icon alone, with COOKREW beside it in one ink, on every page', () => {
    const home = homePage(input).body
    expect(BRAND_MARK_SVG).toContain('class="mark-coo"')
    expect(home).toContain(BRAND_MARK_SVG)
    expect(home).toContain('<span>COOKREW</span>')
    expect(home).not.toContain('COOK<b>REW</b>')
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).toContain(BRAND_MARK_SVG)
  })

  it('the favicon stands alone: the glove inlined on an amber tile', () => {
    expect(FAVICON_SVG).toContain('<image href="data:image/png;base64,')
    expect(FAVICON_SVG).toContain('fill="#ffd600"')
    expect(FAVICON_SVG.startsWith('<svg xmlns=')).toBe(true)
  })
})
