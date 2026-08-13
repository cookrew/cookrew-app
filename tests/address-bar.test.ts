import { describe, expect, it } from 'vitest'
import { SEARCH_URL, resolveAddress } from '../src/shared/address-bar'

describe('resolveAddress', () => {
  it('completes a bare host to https and canonicalises it', () => {
    expect(resolveAddress('GitHub.com')).toBe('https://github.com/')
    expect(resolveAddress('example.co.uk')).toBe('https://example.co.uk/')
  })

  it('keeps the path, query and hash of a bare host', () => {
    expect(resolveAddress('github.com/anthropics/claude-code')).toBe(
      'https://github.com/anthropics/claude-code'
    )
    expect(resolveAddress('example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveAddress('  github.com  ')).toBe('https://github.com/')
  })

  it('leaves an already-schemed web URL alone', () => {
    expect(resolveAddress('https://example.com/x')).toBe('https://example.com/x')
    expect(resolveAddress('http://example.com/x')).toBe('http://example.com/x')
  })

  it('preserves the schemes a browser pane legitimately sits on', () => {
    expect(resolveAddress('about:blank')).toBe('about:blank')
    expect(resolveAddress('file:///Users/me/report.html')).toBe('file:///Users/me/report.html')
  })

  // host:port is the classic address-bar trap: new URL('localhost:3000') does
  // NOT throw — it parses as scheme "localhost" — so it must be recognised as
  // a host before any scheme handling runs.
  it('reads host:port as a host, not a scheme', () => {
    expect(resolveAddress('localhost:3000')).toBe('http://localhost:3000/')
    expect(resolveAddress('localhost:5173/canvas')).toBe('http://localhost:5173/canvas')
    expect(resolveAddress('example.com:8443')).toBe('https://example.com:8443/')
  })

  it('uses http for loopback and LAN hosts, https for public ones', () => {
    expect(resolveAddress('localhost')).toBe('http://localhost/')
    expect(resolveAddress('127.0.0.1:8639')).toBe('http://127.0.0.1:8639/')
    expect(resolveAddress('192.168.1.5')).toBe('http://192.168.1.5/')
    expect(resolveAddress('mac.local:8643')).toBe('http://mac.local:8643/')
  })

  it('searches for input that is not addressable', () => {
    expect(resolveAddress('cookrew launch plan')).toBe(
      `${SEARCH_URL}${encodeURIComponent('cookrew launch plan')}`
    )
    expect(resolveAddress('cookrew')).toBe(`${SEARCH_URL}${encodeURIComponent('cookrew')}`)
  })

  // A typed scheme outside the navigable set would otherwise hand the pane to
  // whatever local handler claims it (mailto:, custom app schemes).
  it('searches rather than launching an unknown scheme', () => {
    expect(resolveAddress('mailto:someone@example.com')).toBe(
      `${SEARCH_URL}${encodeURIComponent('mailto:someone@example.com')}`
    )
  })

  it('returns null for empty input so a blank commit navigates nowhere', () => {
    expect(resolveAddress('')).toBeNull()
    expect(resolveAddress('   ')).toBeNull()
  })
})
