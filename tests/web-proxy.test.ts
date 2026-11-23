// A PAGE SERVED THROUGH THIS COMPUTER (shared/web-proxy.ts): addresses rewritten,
// session kept here, and the two things that must never be fetched.
import { describe, expect, it } from 'vitest'
import { allowedTarget, blockedHost, cookieScope, decodeTarget, encodeTarget, PROXY_SHIM, proxyPath, rewriteCss, rewriteHtml, rewriteUrl, siteOf } from '../src/shared/web-proxy'

const CARD = 'card-1'
const BASE = 'https://shop.example/checkout/page'
const via = (target: string): string => proxyPath(CARD, target)

describe('a target address as a path segment', () => {
  it('round-trips, and refuses a segment we did not write', () => {
    const url = 'https://shop.example/a/b?c=d&e=f#frag'
    expect(decodeTarget(encodeTarget(url))).toBe(url)
    expect(decodeTarget('not/base64!!')).toBeNull()
    expect(decodeTarget(encodeTarget('not a url'))).toBeNull()
  })
})

describe('which addresses may be fetched', () => {
  it('never this machine, its network, or a metadata service', () => {
    for (const host of ['localhost', 'x.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', 'metadata.google.internal', '[::1]']) {
      expect(blockedHost(host), host).toBe(true)
    }
    expect(blockedHost('shop.example')).toBe(false)
    expect(blockedHost('cdn.example.net')).toBe(false)
  })

  it('refuses a target that is not http(s) or is blocked', () => {
    expect(allowedTarget(BASE, 'https://cdn.example.net/x.js')).toBe(true)
    expect(allowedTarget(BASE, 'http://cdn.example.net/x.js')).toBe(true)
    expect(allowedTarget(BASE, 'file:///etc/passwd')).toBe(false)
    expect(allowedTarget(BASE, 'http://127.0.0.1:3425/')).toBe(false)
    expect(allowedTarget(BASE, 'not a url')).toBe(false)
  })

  it('sends cookies only to the card’s own site', () => {
    expect(cookieScope(BASE, 'shop.example')).toBe(true)
    expect(cookieScope(BASE, 'www.shop.example')).toBe(true)
    expect(siteOf('a.b.shop.example')).toBe('shop.example')
    // A different site is a different cookie jar: a CDN gets no session cookie.
    expect(cookieScope(BASE, 'cdn.example.net')).toBe(false)
    expect(cookieScope(BASE, 'other.example')).toBe(false)
  })
})

describe('one address in a page', () => {
  it('becomes a path here, absolute or relative to the page', () => {
    expect(rewriteUrl('https://shop.example/a', BASE, CARD)).toBe(via('https://shop.example/a'))
    expect(rewriteUrl('/assets/app.js', BASE, CARD)).toBe(via('https://shop.example/assets/app.js'))
    expect(rewriteUrl('../img/logo.png', BASE, CARD)).toBe(via('https://shop.example/img/logo.png'))
    expect(rewriteUrl('//cdn.example.net/x.css', BASE, CARD)).toBe(via('https://cdn.example.net/x.css'))
  })

  it('is left alone when it is not a network read', () => {
    for (const keep of ['#top', 'mailto:a@b.c', 'tel:123', 'data:image/png;base64,AA', 'javascript:void 0', 'blob:https://x/y', 'about:blank']) {
      expect(rewriteUrl(keep, BASE, CARD), keep).toBeNull()
    }
  })
})

describe('the page', () => {
  it('has its attributes rewritten and keeps everything else', () => {
    const html = '<a href="/x">x</a><img src="pic.png"><form action="https://shop.example/post"><link href=\'https://cdn.example.net/s.css\'>'
    const out = rewriteHtml(html, BASE, CARD)
    expect(out).toContain(`href="${via('https://shop.example/x')}"`)
    // A relative address resolves against the PAGE, as a browser resolves it.
    expect(out).toContain(`src="${via('https://shop.example/checkout/pic.png')}"`)
    expect(out).toContain(`action="${via('https://shop.example/post')}"`)
    expect(out).toContain(`href='${via('https://cdn.example.net/s.css')}'`)
    expect(out).toContain('>x</a>')
  })

  it('rewrites each candidate of a srcset', () => {
    const out = rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', BASE, CARD)
    expect(out).toContain(`${via('https://shop.example/a.png')} 1x`)
    expect(out).toContain(`${via('https://shop.example/b.png')} 2x`)
  })

  it('leaves code-running addresses out of the rewrite', () => {
    const out = rewriteHtml('<a href="javascript:alert(1)">x</a>', BASE, CARD)
    expect(out).toContain('javascript:alert(1)')
  })
})

describe('a stylesheet', () => {
  it('points its url() at this computer', () => {
    const css = 'body{background:url("/bg.png")} .a{background:url(https://cdn.example.net/x.woff)}'
    const out = rewriteCss(css, 'https://shop.example/css/site.css', CARD)
    expect(out).toContain(`url("/api/proxy/card-1/${encodeTarget('https://shop.example/bg.png')}")`)
    expect(out).toContain(`url(${via('https://cdn.example.net/x.woff')})`)
  })
})

describe('the shim placed in a page', () => {
  it('says a live connection needs the screen, and never invents its own prefix', () => {
    expect(PROXY_SHIM).toContain('needs-screen')
    expect(PROXY_SHIM).toContain('/api/proxy')
    expect(PROXY_SHIM).not.toContain('eval(')
  })
})
