import { describe, expect, it } from 'vitest'
import { canonicalExternalUrl, canonicalWebUrl, externalOpenMode, isWebUrl } from '../src/shared/external-url'

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
    expect(isWebUrl('chrome-error://chromewebdata/')).toBe(false)
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
    expect(canonicalWebUrl('chrome-error://chromewebdata/')).toBeNull()
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

/**
 * Local docs are a first-class thing to hand off: reports are produced as
 * .html on disk and opened in a canvas browser, and "read this properly / on
 * my phone" means a real browser. Refusing every file: URL made that button
 * permanently dead on exactly the cards it was needed for.
 *
 * But file: is NOT web: shell.openExternal hands the path to the OS default
 * handler for that FILE TYPE, so `.command`, `.app` or `.sh` would RUN rather
 * than render. A page can steer a tab's url (did-navigate, window.open), so
 * the boundary cannot assume the string came from the user.
 */
describe('canonicalExternalUrl — local files, without handing the OS an executable', () => {
  it('opens the local documents this app produces', () => {
    for (const url of [
      'file:///Users/drej/workspace/cookrew-dev/docs/design/herdr-migration-plan.html',
      'file:///tmp/report.htm',
      'file:///tmp/spec.pdf',
      'file:///tmp/notes.md',
      'file:///tmp/data.csv',
      'file:///tmp/shot.png'
    ]) {
      expect(canonicalExternalUrl(url)).not.toBeNull()
    }
  })

  it('REFUSES anything the OS would execute rather than render', () => {
    for (const url of [
      'file:///tmp/evil.command',
      'file:///tmp/evil.sh',
      'file:///Applications/Calculator.app',
      'file:///tmp/installer.pkg',
      'file:///tmp/thing.dmg',
      'file:///tmp/macro.scpt',
      'file:///tmp/x.terminal'
    ]) {
      expect(canonicalExternalUrl(url)).toBeNull()
    }
  })

  it('refuses a file with no extension at all — unknown handler, unknown result', () => {
    expect(canonicalExternalUrl('file:///tmp/mystery')).toBeNull()
    expect(canonicalExternalUrl('file:///tmp/')).toBeNull()
  })

  it('is not fooled by an extension in the query or fragment', () => {
    expect(canonicalExternalUrl('file:///tmp/evil.command?x=.html')).toBeNull()
    expect(canonicalExternalUrl('file:///tmp/evil.command#.html')).toBeNull()
  })

  it('matches the extension case-insensitively', () => {
    expect(canonicalExternalUrl('file:///tmp/Report.HTML')).not.toBeNull()
  })

  it('still carries every web URL, unchanged', () => {
    expect(canonicalExternalUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(canonicalExternalUrl('ftp://example.com')).toBeNull()
  })

  it('returns the CANONICAL href, so the checked string is the opened one', () => {
    // Same smuggling gap canonicalWebUrl closes, on the file path too.
    expect(canonicalExternalUrl('file:///tmp/a b.html')).toBe('file:///tmp/a%20b.html')
  })
})

describe('externalOpenMode — a local doc is now openable, not disabled', () => {
  it('enables the desktop button for a local .html', () => {
    expect(externalOpenMode(true, 'file:///tmp/report.html')).toBe('bridge')
  })

  it('still disables it for a file the OS would execute', () => {
    expect(externalOpenMode(true, 'file:///tmp/evil.command')).toBe('disabled')
  })

  it('phone/demo gets no anchor for file: — the path means nothing on that device', () => {
    expect(externalOpenMode(false, 'file:///tmp/report.html')).toBe('hidden')
  })
})
