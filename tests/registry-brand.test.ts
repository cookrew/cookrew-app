import { describe, expect, it } from 'vitest'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML } from '../registry/src/site-brand'
import { ASSETS } from '../registry/src/assets-bundle'
import { FAVICON_SVG } from '../registry/src/site-seo'
import { homePage, marketPage, marketQuery } from '../registry/src/site'

const input = { doors: [], presets: [], release: null, stars: () => 0, pulse: () => ({ opens: 0, lines: 0, callers: 0 }) as never, linesToday: 0, commits: null }

describe('the brand: the amber lockup', () => {
  it('ships the C hand as a bundled asset and colours it through a mask, never a data uri', () => {
    expect(ASSETS['c-hand.png']?.type).toBe('image/png')
    expect(ASSETS['c-hand.png']?.encoding).toBe('base64')
    expect(BRAND_LOCKUP_CSS).toContain('/assets/c-hand.png?v=')
    expect(BRAND_LOCKUP_CSS).toContain('mask-mode:alpha')
    expect(BRAND_LOCKUP_CSS).not.toContain('base64')
  })

  it('takes turns: the tank and the pac-man each run eight seconds, visibility alternating over sixteen', () => {
    expect(BRAND_LOCKUP_HTML).toContain('class="lk lk-a"')
    expect(BRAND_LOCKUP_HTML).toContain('class="lk lk-b"')
    expect(BRAND_LOCKUP_HTML).toContain('t tk')
    expect(BRAND_LOCKUP_HTML).toContain('t pm')
    expect(BRAND_LOCKUP_HTML).not.toContain('class="cb"')
    expect(BRAND_LOCKUP_CSS).toMatch(/@keyframes brand-a\{0%,49\.99%\{visibility:visible\}50%,100%\{visibility:hidden\}\}/)
    expect(BRAND_LOCKUP_CSS).toMatch(/@keyframes brand-b\{0%,49\.99%\{visibility:hidden\}50%,100%\{visibility:visible\}\}/)
    expect(BRAND_LOCKUP_CSS).toContain('tk-move 8s')
    expect(BRAND_LOCKUP_CSS).toContain('pm-move 8s')
  })

  it('the eyes move: the iris spins, the gaze wanders, the lids blink', () => {
    for (const k of ['lk-spin', 'brand-gaze', 'brand-blink']) expect(BRAND_LOCKUP_CSS).toContain(`@keyframes ${k}`)
    // the gaze rides the hand's eight-second cycle, not a six-second wander of its own
    expect(BRAND_LOCKUP_CSS).toContain('.brand .lk .pupil{animation:brand-gaze 8s')
  })

  it('the home page carries the moving lockup and still no script; the market page does not carry it', () => {
    const home = homePage(input).body
    expect(home).toContain('class="brand"')
    expect(home).toContain(BRAND_LOCKUP_HTML)
    // the JSON-LD block is data, not a script; nothing executable may join the page
    expect(home).not.toMatch(/<script(?![^>]*application\/ld\+json)/)
    expect(marketPage({ ...input, query: marketQuery(new URLSearchParams()), starredTeams: [] } as never).body).not.toContain('class="brand"')
  })

  it('the header mark and the favicon are the C hand on a dark tile', () => {
    const home = homePage(input).body
    expect(home).toContain('<span class="mark-c" aria-hidden="true"><i></i></span>')
    expect(home).toContain('.mark-c i{')
    expect(FAVICON_SVG).toContain('<image href="data:image/png;base64,')
    expect(FAVICON_SVG).toContain('fill="#14110a"')
    expect(FAVICON_SVG).toContain('feColorMatrix')
  })
})
