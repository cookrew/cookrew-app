// ONE MARK, EVERYWHERE. The wireframe hand is generated, not drawn, so the
// app's mark, the site's header and the favicon cannot drift apart: this file
// holds them to the same three paths.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { faviconSvg, handCuff, handMesh, handOutline, markSvg } from '../src/shared/brand-mark'
import { CrLogoMark } from '../src/renderer/src/CrLogoMark'
import { FAVICON_SVG } from '../registry/src/site-seo'

describe('the wireframe hand', () => {
  it('is a C: open on the right, a cuff at the bottom-left, closed', () => {
    const d = handOutline()
    expect(d.startsWith('M 26.19 9.29')).toBe(true) // the fingertip, at −40°
    expect(d).toContain('L 5.4 25.8 L 5.4 33 L 14.2 33') // the cuff
    expect(d.endsWith('Z')).toBe(true)
  })

  it('is a wireframe: three arcs along the band and a spoke every 15°', () => {
    const mesh = handMesh()
    expect((mesh.match(/A 7\.5 7\.5|A 9 9|A 10\.5 10\.5/g) ?? []).length).toBe(3)
    // from −55° down to −310° inclusive, every 15° — the whole back of the hand
    expect((mesh.match(/ L /g) ?? []).length).toBe(18)
  })

  it('is the same geometry in the app and on the site', () => {
    const app = renderToStaticMarkup(<CrLogoMark />)
    const site = markSvg()
    for (const d of [handOutline(), handMesh(), handCuff()]) {
      expect(app).toContain(`d="${d}"`)
      expect(site).toContain(`d="${d}"`)
    }
    expect(app).toContain('cr-logo-mark')
    expect(app).toContain('a wireframe hand making a C')
  })

  it('wears the caller’s colour — every stroke is currentColor, nothing filled', () => {
    const svg = markSvg()
    expect(svg).not.toMatch(/fill="(?!none)/)
    expect((svg.match(/stroke="currentColor"/g) ?? []).length).toBe(3)
  })

  it('drops the mesh when asked, for the sizes it would be noise at', () => {
    expect(markSvg({ plain: true })).not.toContain(handMesh())
    expect(markSvg({ plain: true })).toContain(handOutline())
  })

  it('is the favicon, cyan on the dark tile, self-contained', () => {
    expect(FAVICON_SVG).toBe(faviconSvg())
    expect(FAVICON_SVG).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(FAVICON_SVG).toContain('#3ee8e0')
    expect(FAVICON_SVG).toContain(handOutline())
    expect(FAVICON_SVG).not.toContain('currentColor="')
  })
})
