// Chromium uses chrome-error://chromewebdata/ as the document URL after a
// failed navigation. It must never become application state or be fed back to
// Electron's loadURL — macOS has no handler for Chromium's private scheme.

import { describe, expect, it } from 'vitest'
import {
  BLANK_BROWSER_PAGE,
  CHROMIUM_ERROR_PAGE,
  browserUrlForLoad,
  isChromiumErrorPage,
  observedBrowserUrl
} from '../src/shared/browser-navigation'

describe('Chromium navigation failure fixture', () => {
  it('recognizes the private error-page scheme, including case variants', () => {
    expect(isChromiumErrorPage(CHROMIUM_ERROR_PAGE)).toBe(true)
    expect(isChromiumErrorPage('CHROME-ERROR://chromewebdata/')).toBe(true)
    expect(isChromiumErrorPage('https://example.com/chrome-error://chromewebdata/')).toBe(false)
  })

  it('keeps the requested address when the browser reports its error document', () => {
    expect(observedBrowserUrl('https://unreachable.example/', CHROMIUM_ERROR_PAGE)).toBe(
      'https://unreachable.example/'
    )
  })

  it('never replays a previously persisted error document through loadURL', () => {
    expect(browserUrlForLoad(CHROMIUM_ERROR_PAGE)).toBe(BLANK_BROWSER_PAGE)
    expect(browserUrlForLoad('https://example.com/')).toBe('https://example.com/')
    expect(browserUrlForLoad('file:///tmp/report.html')).toBe('file:///tmp/report.html')
  })

  it('continues to record ordinary navigation, including about:blank', () => {
    expect(observedBrowserUrl('https://old.example/', 'https://new.example/')).toBe(
      'https://new.example/'
    )
    expect(observedBrowserUrl('https://old.example/', BLANK_BROWSER_PAGE)).toBe(
      BLANK_BROWSER_PAGE
    )
  })
})
