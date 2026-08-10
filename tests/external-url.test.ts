import { describe, expect, it } from 'vitest'
import { canonicalWebUrl, externalOpenMode, isWebUrl } from '../src/shared/external-url'

/**
 * The predicate behind the "open in browser" button AND the main-process
 * shell:openExternal boundary. The dangerous failure is over-acceptance:
 * shell.openExternal on a non-web scheme launches whatever local handler
 * claims it, so everything that is not plainly http(s) must be refused.
 */
describe('isWebUrl', () => {
  it('accepts plain web URLs', () => {
    expect(isWebUrl('https://maps.google.com/dir/A/B')).toBe(true)
    expect(isWebUrl('http://example.com')).toBe(true)
    expect(isWebUrl('https://claude.ai/public/artifacts/abc')).toBe(true)
  })

  it('refuses every non-web scheme — the openExternal boundary', () => {
    expect(isWebUrl('file:///Users/me/report.html')).toBe(false)
    expect(isWebUrl('smb://server/share')).toBe(false)
    expect(isWebUrl('notion://page/abc')).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('about:blank')).toBe(false)
  })

  it('refuses scheme-smuggling lookalikes', () => {
    // URL parses these with a non-http protocol; a substring check would not.
    expect(isWebUrl('httpss://example.com')).toBe(false)
    expect(isWebUrl('file://example.com/https://x')).toBe(false)
  })

  it('refuses junk without throwing', () => {
    expect(isWebUrl('')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
    expect(isWebUrl('//protocol-relative.com')).toBe(false)
  })
})

describe('canonicalWebUrl — what actually gets opened', () => {
  it('returns the parsed href, never the raw string', () => {
    // WHATWG URL strips embedded tab/LF and trims whitespace, so a raw string
    // that VALIDATES as https can read differently to the OS parser it is
    // handed to. Opening the canonical form is the fix; this pins it.
    expect(canonicalWebUrl('ht\ntps://example.com')).toBe('https://example.com/')
    expect(canonicalWebUrl('h\ttt\np://example.com')).toBe('http://example.com/')
    expect(canonicalWebUrl(' https://example.com')).toBe('https://example.com/')
  })

  it('percent-encodes shell-hostile characters into the canonical form', () => {
    expect(canonicalWebUrl('https://example.com/" & calc.exe')).toBe(
      'https://example.com/%22%20&%20calc.exe'
    )
  })

  it('is null exactly where isWebUrl refuses', () => {
    expect(canonicalWebUrl('file:///etc/hosts')).toBeNull()
    expect(canonicalWebUrl('about:blank')).toBeNull()
    expect(canonicalWebUrl('')).toBeNull()
  })
})

describe('externalOpenMode — which control renders where', () => {
  it('desktop bridge: button for web URLs, DISABLED (not absent) otherwise', () => {
    // addTab seeds about:blank; hiding the control there would reflow the
    // header on first navigation. Disabled keeps the layout stable.
    expect(externalOpenMode(true, 'https://example.com')).toBe('bridge')
    expect(externalOpenMode(true, 'about:blank')).toBe('disabled')
  })

  it('phone/demo (no bridge): a REAL anchor — the deep-link handoff', () => {
    expect(externalOpenMode(false, 'https://maps.google.com/dir/A/B')).toBe('anchor')
  })

  it('no bridge + non-web URL: hidden — there is no disabled anchor', () => {
    expect(externalOpenMode(false, 'about:blank')).toBe('hidden')
    expect(externalOpenMode(false, 'file:///x.html')).toBe('hidden')
  })
})
