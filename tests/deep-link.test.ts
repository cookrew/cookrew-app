import { describe, expect, it } from 'vitest'
import { createDeepLinkQueue, deepLinkInArgv, parseDeepLink } from '../src/main/deep-link'

/**
 * THE DEEP LINK — `cookrew://` and the canonical https team page, parsed into
 * exactly one of three verbs or refused. A link is never "fixed": a shape the
 * parser does not name is a shape the app will not act on, because the whole
 * point of a link is that it can arrive from anywhere.
 */

const HEX64 = 'a'.repeat(64)

describe('parseDeepLink — accepted shapes', () => {
  it('imports a team by its published name', () => {
    expect(parseDeepLink('cookrew://import/@drej/cookrew-alpha')).toEqual({
      verb: 'import',
      address: '@drej/cookrew-alpha'
    })
  })

  it('carries session=new through, and only that query', () => {
    expect(parseDeepLink('cookrew://import/@drej/cookrew-alpha?session=new')).toEqual({
      verb: 'import',
      address: '@drej/cookrew-alpha',
      session: 'new'
    })
  })

  it('installs a preset by its content address', () => {
    expect(parseDeepLink(`cookrew://install/sha256:${HEX64}`)).toEqual({
      verb: 'install',
      presetId: `sha256:${HEX64}`
    })
  })

  it('serves a team by name', () => {
    expect(parseDeepLink('cookrew://serve/@drej/cookrew-alpha')).toEqual({
      verb: 'serve',
      address: '@drej/cookrew-alpha'
    })
  })

  it('reads the canonical https team page as an import, with or without the @', () => {
    expect(parseDeepLink('https://cookrew.dev/@drej/cookrew-alpha')).toEqual({
      verb: 'import',
      address: '@drej/cookrew-alpha'
    })
    expect(parseDeepLink('https://cookrew.dev/drej/cookrew-alpha')).toEqual({
      verb: 'import',
      address: '@drej/cookrew-alpha'
    })
  })

  it('tolerates surrounding whitespace, which is how argv and pasteboards hand a link over', () => {
    expect(parseDeepLink('  cookrew://import/@drej/cookrew-alpha \n')).toEqual({
      verb: 'import',
      address: '@drej/cookrew-alpha'
    })
  })
})

describe('parseDeepLink — refused shapes', () => {
  const refused: [string, string][] = [
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL at all', '@drej/cookrew-alpha'],
    ['an unknown verb', 'cookrew://open/@drej/cookrew-alpha'],
    ['no verb', 'cookrew:///@drej/cookrew-alpha'],
    ['a handle in the wrong case', 'cookrew://import/@DREJ/cookrew-alpha'],
    ['a handle without the @', 'cookrew://import/drej/cookrew-alpha'],
    ['an import with extra segments', 'cookrew://import/@drej/cookrew-alpha/extra'],
    ['an import of a bare handle', 'cookrew://import/@drej'],
    ['a query other than session=new', 'cookrew://import/@drej/cookrew-alpha?session=old'],
    ['a second query key beside session=new', 'cookrew://import/@drej/cookrew-alpha?session=new&x=1'],
    ['a fragment', 'cookrew://import/@drej/cookrew-alpha#top'],
    ['credentials', 'cookrew://user:pw@import/@drej/cookrew-alpha'],
    ['an install id that is not a content address', 'cookrew://install/my-preset'],
    ['an install id with a short digest', 'cookrew://install/sha256:abc'],
    ['an install id in upper-case hex', `cookrew://install/sha256:${'A'.repeat(64)}`],
    ['an install with a query', `cookrew://install/sha256:${HEX64}?session=new`],
    ['an install with extra segments', `cookrew://install/sha256:${HEX64}/more`],
    ['a serve with a query', 'cookrew://serve/@drej/cookrew-alpha?session=new'],
    ['a serve with extra segments', 'cookrew://serve/@drej/cookrew-alpha/x'],
    ['javascript:', 'javascript:alert(1)'],
    ['a javascript: URL dressed as a verb', 'javascript://import/@drej/cookrew-alpha'],
    ['file:', 'file:///etc/passwd'],
    ['https on a host that is not the registry', 'https://example.com/@drej/cookrew-alpha'],
    ['http on the registry host', 'http://cookrew.dev/@drej/cookrew-alpha'],
    ['https on a look-alike host', 'https://cookrew.dev.evil.com/@drej/cookrew-alpha'],
    ['the registry root', 'https://cookrew.dev/'],
    ['a registry page one deep', 'https://cookrew.dev/@drej'],
    ['a registry page three deep', 'https://cookrew.dev/@drej/cookrew-alpha/extra'],
    ['a registry page with a query', 'https://cookrew.dev/@drej/cookrew-alpha?session=new'],
    ['an https install page (the app has no install surface for it)', `https://cookrew.dev/install/sha256:${HEX64}`]
  ]
  for (const [what, raw] of refused) {
    it(`refuses ${what}`, () => {
      expect(parseDeepLink(raw)).toBeNull()
    })
  }

  it('does not throw on garbage', () => {
    expect(parseDeepLink('cookrew://%%%')).toBeNull()
    expect(parseDeepLink('cookrew://import/%E0%A4%A')).toBeNull()
  })
})

describe('deepLinkInArgv — the second instance on Windows and Linux', () => {
  it('finds the one cookrew:// argument among the launcher flags', () => {
    expect(
      deepLinkInArgv(['/usr/bin/cookrew', '--no-sandbox', 'cookrew://import/@drej/cookrew-alpha'])
    ).toEqual({ verb: 'import', address: '@drej/cookrew-alpha' })
  })

  it('answers null when no argument is a link', () => {
    expect(deepLinkInArgv(['/usr/bin/cookrew', '--flag'])).toBeNull()
    expect(deepLinkInArgv([])).toBeNull()
  })

  it('does not treat a stray https argument as a link', () => {
    expect(deepLinkInArgv(['/usr/bin/cookrew', 'https://cookrew.dev/@drej/cookrew-alpha'])).toBeNull()
  })
})

describe('createDeepLinkQueue — a link that arrives before the window can hear it', () => {
  it('holds links until the renderer is ready, then delivers them in order', () => {
    const sent: unknown[] = []
    const queue = createDeepLinkQueue((link) => sent.push(link))
    queue.push({ verb: 'import', address: '@drej/one' })
    queue.push({ verb: 'serve', address: '@drej/two' })
    expect(sent).toEqual([])
    queue.ready()
    expect(sent).toEqual([
      { verb: 'import', address: '@drej/one' },
      { verb: 'serve', address: '@drej/two' }
    ])
  })

  it('delivers immediately once ready', () => {
    const sent: unknown[] = []
    const queue = createDeepLinkQueue((link) => sent.push(link))
    queue.ready()
    queue.push({ verb: 'import', address: '@drej/one' })
    expect(sent).toEqual([{ verb: 'import', address: '@drej/one' }])
  })

  it('goes back to holding when the window is gone, and flushes to the next one', () => {
    const sent: unknown[] = []
    const queue = createDeepLinkQueue((link) => sent.push(link))
    queue.ready()
    queue.gone()
    queue.push({ verb: 'import', address: '@drej/one' })
    expect(sent).toEqual([])
    queue.ready()
    expect(sent).toEqual([{ verb: 'import', address: '@drej/one' }])
  })
})
