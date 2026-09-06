// ONE PICTURE, EVERYWHERE. The mark is the owner's render, not a drawing of
// it, so the app's bar, the site's header, the favicon and the hero all carry
// the same bytes; this file holds them to it, and holds the lockup's shape.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WIRE_HAND_64, lensEyeSvg } from '../src/shared/brand-hand'
import { CrLogoMark } from '../src/renderer/src/CrLogoMark'
import { FAVICON_SVG } from '../registry/src/site-seo'
import { ASSETS } from '../registry/src/assets-bundle'
import { brandBand } from '../registry/src/site-home'

describe('the mark is the render', () => {
  it('is a PNG data URI, the same in the app’s mark and the site’s favicon', () => {
    expect(WIRE_HAND_64.startsWith('data:image/png;base64,')).toBe(true)
    expect(renderToStaticMarkup(<CrLogoMark />)).toContain(`src="${WIRE_HAND_64}"`)
    expect(FAVICON_SVG).toContain(`href="${WIRE_HAND_64}"`)
    expect(FAVICON_SVG).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('ships the full render in the registry bundle for the hero', () => {
    expect(ASSETS['wire-hand.png']?.type).toBe('image/png')
    expect(ASSETS['wire-hand.png']?.encoding).toBe('base64')
    expect(ASSETS['wire-hand-64.png']?.type).toBe('image/png')
    // the 64 px file IS the data URI, byte for byte
    expect(WIRE_HAND_64.slice('data:image/png;base64,'.length)).toBe(ASSETS['wire-hand-64.png']?.body)
  })

  it('keeps the bar’s mark class, and the typing hand under another name', () => {
    expect(renderToStaticMarkup(<CrLogoMark />)).toContain('class="cr-logo-mark"')
    expect(renderToStaticMarkup(<CrLogoMark className="cr-hand2-mark" />)).not.toContain('cr-logo-mark')
  })
})

describe('the lockup', () => {
  it('is a robot lens eye: rim, ticks, iris, pupil, lid', () => {
    const eye = lensEyeSvg()
    for (const part of ['class="rim"', 'class="ticks"', 'class="iris"', 'class="pupil"', 'class="lid"', 'class="lidline"']) {
      expect(eye).toContain(part)
    }
  })

  it('on the site: the render as the C, two eyes, outlined K R E W, dashed cables, the small hand', () => {
    const band = brandBand()
    expect(band).toContain('src="/assets/wire-hand.png?v=')
    expect((band.match(/<span class="o"><svg class="eye"/g) ?? []).length).toBe(2)
    expect(band).toContain('<span class="l">K</span><span class="l">R</span><span class="l">E</span><span class="l">W</span>')
    expect(band).toContain('class="cb"')
    expect(band).toContain('class="tt"') // the cable that follows the hand
    expect(band).toContain(`<img class="h" src="${WIRE_HAND_64}"`)
    expect(band).toContain('aria-label="COOKREW"')
    expect(band).not.toContain('<script')
  })
})
