import { describe, expect, it } from 'vitest'
import { AUTH_PAGE_CSP, authPageHtml } from '../registry/src/auth-page'
import { ASSETS } from '../registry/src/assets-bundle'

const base = { authOrigin: 'https://auth.cookrew.dev', productOrigin: 'https://cookrew.dev', assetVersion: 'abc123' } as const

describe('auth page', () => {
  it('renders the sign-in page and the device page from one frame', () => {
    const home = authPageHtml({ ...base, path: '/' })
    const device = authPageHtml({ ...base, path: '/device' })
    for (const html of [home, device]) {
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain('id="screen"')
      expect(html).toContain('id="who"')
      expect(html).toContain('One account.')
      expect(html).toContain('© Cookrew')
      expect(html).toContain('class="mark-coo"')
      expect(html).toContain('<span class="lock">')
      expect(html).toContain('auth.cookrew.dev</span>')
    }
    expect(home).toContain('data-path="/"')
    expect(device).toContain('data-path="/device"')
  })

  it('loads exactly one script, from this origin, versioned, and runs nothing inline', () => {
    const html = authPageHtml({ ...base, path: '/' })
    const scripts = html.match(/<script\b[^>]*>/g) ?? []
    expect(scripts).toEqual(['<script src="/assets/auth.js?v=abc123" defer>'])
    expect(html).toMatch(/<script src="\/assets\/auth\.js\?v=abc123" defer><\/script>/)
    expect(html).not.toMatch(/\son[a-z]+=/i)
    expect(html).not.toContain('javascript:')
  })

  it('has a strict policy: no eval, no inline script, no framing, no form posts', () => {
    expect(AUTH_PAGE_CSP).not.toContain('unsafe-eval')
    const script = AUTH_PAGE_CSP.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))
    expect(script).toBe("script-src 'self'")
    for (const directive of ["default-src 'none'", "connect-src 'self'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'", "img-src 'self' data:", "font-src 'self'"]) {
      expect(AUTH_PAGE_CSP).toContain(directive)
    }
  })

  it('escapes the origins it is given', () => {
    const html = authPageHtml({
      authOrigin: 'https://auth.example"><script>alert(1)</script>',
      productOrigin: 'https://evil.example/"><img src=x onerror=alert(1)>',
      assetVersion: '"><script>',
      path: '/'
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html.match(/<script\b/g)?.length).toBe(1)
  })

  it('wears the site palette in light and dark', () => {
    const html = authPageHtml({ ...base, path: '/' })
    expect(html).toContain('--cream:#f4efe4')
    expect(html).toContain('@media (prefers-color-scheme:dark)')
    expect(html).toContain('--font-serif')
  })

  it('never offers an email sign-in', () => {
    const html = authPageHtml({ ...base, path: '/' })
    const script = ASSETS['auth.js']?.body ?? ''
    expect(script.length).toBeGreaterThan(0)
    expect(html.toLowerCase()).not.toContain('email or username')
    expect(script).not.toMatch(/type:\s*'email'/)
    expect(script).toContain("field('Username'")
  })

  it('stays lean: page and script under the budget, and the script ships without console logging', () => {
    const html = authPageHtml({ ...base, path: '/' })
    const script = ASSETS['auth.js']?.body ?? ''
    expect(script).not.toContain('console.')
    expect(Buffer.byteLength(html) + Buffer.byteLength(script)).toBeLessThan(60 * 1024)
  })
})
