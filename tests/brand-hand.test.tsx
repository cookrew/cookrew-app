// THE HAND IS THE C. The owner's voxel render takes the C's place in the
// wordmark; the app's bar, the site's header and the favicon draw the same
// bytes, and the word stays COOKREW to anything that reads rather than looks.

import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { VOXEL_HAND_72 } from '../src/shared/brand-hand'
import { CrLogoMark } from '../src/renderer/src/CrLogoMark'
import { Header } from '../src/renderer/src/Header'
import { FAVICON_SVG } from '../registry/src/site-seo'
import { page } from '../registry/src/site-shell'

const bar = (): string =>
  renderToStaticMarkup(
    <Header
      workspaceName="Cookrew Dev"
      dir="/tmp"
      terminalCount={1}
      busyCount={0}
      attentionCount={0}
      view="canvas"
      onViewChange={() => undefined}
      onActivity={() => undefined}
      onResync={() => undefined}
      avatar={null}
    />,
  )

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('the mark is the voxel render', () => {
  it('is one PNG data URI, drawn by the app, the site header and the favicon', () => {
    expect(VOXEL_HAND_72.startsWith('data:image/png;base64,')).toBe(true)
    expect(renderToStaticMarkup(<CrLogoMark />)).toContain(`src="${VOXEL_HAND_72}"`)
    expect(FAVICON_SVG).toContain(`href="${VOXEL_HAND_72}"`)
    expect(page({ title: 't', kind: 'document' }, '').body).toContain(`<img src="${VOXEL_HAND_72}"`)
  })

  it('takes the C’s place on the desktop bar — the word reads OOKREW after it, and is COOKREW to a reader', () => {
    ;(globalThis as { window?: unknown }).window = { cookrew: {}, setTimeout: () => 0, clearTimeout: () => undefined }
    const html = bar()
    expect(html).toContain('cr-logo-mark')
    expect(html).toContain('aria-label="COOKREW">OOKREW<')
    expect(html.indexOf('cr-logo-mark')).toBeLessThan(html.indexOf('OOKREW'))
  })

  it('writes the word out on the phone, where the path badge stands in for the mark', () => {
    ;(globalThis as { window?: unknown }).window = {
      COOKREW_MOBILE: 1,
      location: { origin: 'https://desktop.test', pathname: '/', search: '' },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    const html = bar()
    expect(html).not.toContain('cr-logo-mark')
    expect(html).toContain('aria-label="COOKREW">COOKREW<')
  })

  it('does the same on the site: the hand, then OOKREW, named COOKREW', () => {
    const body = page({ title: 't', kind: 'document' }, '').body
    expect(body).toContain('<a class="mark" href="/" aria-label="COOKREW">')
    expect(body).toContain('>OOK<b>REW</b></span></a>')
  })
})
