import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TopBar, initialsOf } from '../src/renderer/src/console/ConsoleDevicesView'
import { hasTrafficLights } from '../src/renderer/src/Header'

/**
 * ONE TOP BAR (owner 2026-11-12): the console's Devices level before the
 * password and after, and every machine inside, wear the app's own bar, the
 * Co at its front.
 */

const MAC_ELECTRON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) cookrew/0.6.5 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('the room for the traffic lights', () => {
  it('only the Mac window has them: there the bar keeps their room; the console and other desktops give it to the mark', () => {
    expect(hasTrafficLights(MAC_ELECTRON, 'MacIntel')).toBe(true)
    expect(hasTrafficLights(MAC_CHROME, 'MacIntel')).toBe(false)
    expect(hasTrafficLights(MAC_ELECTRON.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0; Win64; x64'), 'Win32')).toBe(false)
  })

  it('the app’s bar leads with the Co, and keeps 88px only beside the lights', () => {
    const header = readFileSync('src/renderer/src/Header.tsx', 'utf8')
    expect(header).toMatch(/<header className=\{`cr-header\$\{LIGHTS \? ' cr-lights' : ''\}`\}>\s*\{\/\*[\s\S]*?\*\/\}\s*<span className="cr-mark"/)
    const css = readFileSync('src/renderer/src/header.css', 'utf8')
    expect(css).toContain('.cr-header:not(.cr-lights) {\n  padding-left: 16px;')
    expect(css).toContain("mask: url('./brand/co-mark.svg')")
  })
})

describe('the console’s bar on the Devices level', () => {
  it('is the app’s: the Co, the route at Devices, the account’s avatar with its initials', () => {
    const html = renderToStaticMarkup(createElement(TopBar, { username: 'acceptance', accountHref: 'https://auth.example/account', onSignOut: () => undefined }))
    expect(html).toMatch(/^<header class="cr-header cd-bar"><span class="cr-mark" role="img" aria-label="Cookrew"><\/span>/)
    expect(html).toContain('<span class="cr-route-label">Devices</span>')
    expect(html).toContain('class="cr-acct-avatar cr-acct-claimed"')
    expect(html).toContain('>AC</span>')
    expect(html).toContain('aria-label="Account @acceptance"')
    // Closed until pressed: the way to the account and out are in its menu.
    expect(html).not.toContain('Sign out')
  })

  it('wears the letters the app’s avatar does', () => {
    expect(initialsOf('drej')).toBe('DR')
    expect(initialsOf('ada.lovelace')).toBe('AL')
    expect(initialsOf('  ')).toBe('?')
  })
})
