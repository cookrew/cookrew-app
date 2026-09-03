import { describe, expect, it } from 'vitest'
import { RESERVED_HANDLES, handlePage, homePage, marketPage, marketQuery, teamPage } from '../registry/src/site'
import type { ListedDoor } from '../registry/src/site'
import type { Release } from '../registry/src/releases'

/**
 * THE PUBLIC FACE OF cookrew.dev.
 *
 * These pages are read by people deciding whether to open somebody else's
 * team, so what they must never do matters more than what they say: a
 * DOCUMENT (the front page, an owner's page) can run nothing; an APP page (the
 * market, a team's page) loads exactly one origin's scripts and talks to one
 * origin; neither leaks where the author's machine is, and neither implies
 * the reader is entitled to something the gate has not granted yet.
 */

const door = (over: Partial<ListedDoor> = {}): ListedDoor => ({
  handle: 'drej',
  name: 'cookrew-alpha',
  title: 'COOKREW Alpha',
  door: 'Pilot',
  agents: 3,
  address: 'https://cookrew.dev/@drej/cookrew-alpha',
  transport: 'relay',
  access: 'paid',
  priceUsd: '2.50',
  rails: ['x402', 'stripe'],
  sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
  seenAt: 1,
  ...over
})

const release: Release = {
  version: '0.1.2',
  tag: 'v0.1.2',
  publishedAt: '2026-08-28T14:05:26Z',
  url: 'https://github.com/cookrew/cookrew-app/releases/tag/v0.1.2',
  assets: [
    { name: 'Cookrew-0.1.2-arm64.dmg', url: 'https://x/dmg', bytes: 120_000_000 },
    { name: 'Cookrew-0.1.2-windows-preview-x64.exe', url: 'https://x/exe', bytes: 90_000_000 }
  ]
}

const stars = (): number => 0
const home = (doors: ListedDoor[], rel: Release | null = release) =>
  homePage({ doors, release: rel, stars, pulse: () => ({ lines: 2, calls: 9 }), linesToday: 2, commits: [{ sha: 'a7e1d0b', title: 'feat: the web line', date: '2026-09-03', url: 'https://github.com/cookrew/cookrew-app/commit/a7e1d0b' }] })
const team = (d: ListedDoor | null, over: Partial<Parameters<typeof teamPage>[0]> = {}) =>
  teamPage({ door: d, origin: 'https://cookrew.dev', stars: 0, starred: false, account: null, ...over })
const market = (doors: ListedDoor[], params = '', over: Partial<Parameters<typeof marketPage>[0]> = {}) =>
  marketPage({
    doors,
    presets: [],
    query: marketQuery(new URLSearchParams(params)),
    stars,
    account: null,
    starredTeams: [],
    ...over
  })

describe('a document can express nothing at all', () => {
  it('the front page and an owner’s page: no script, no form, no handler', () => {
    for (const page of [home([door()]), handlePage('drej', [door()])]) {
      // One script is allowed on a document: the JSON-LD graph, which runs nothing.
      expect(page.body).not.toMatch(/<script(?! type="application\/ld\+json")/i)
      expect(page.body).not.toMatch(/<form/i)
      expect(page.body).not.toMatch(/\son[a-z]+=/i)
      expect(page.body).not.toMatch(/javascript:/i)
      // And it is told so, rather than merely happening not to contain one.
      expect(page.headers['content-security-policy']).toContain("script-src 'none'")
      expect(page.headers['content-security-policy']).toContain("form-action 'none'")
    }
  })

  it('an app page loads scripts from this origin only, and talks to this origin only', () => {
    for (const page of [team(door()), market([door()])]) {
      const csp = page.headers['content-security-policy']
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("connect-src 'self'")
      expect(csp).not.toContain('unsafe-eval')
      expect(page.body).not.toMatch(/<script>/i)
      expect(page.body).not.toMatch(/<script[^>]*src="(?!\/assets\/)/i)
      expect(page.body).not.toMatch(/\son[a-z]+=/i)
      expect(page.body).not.toMatch(/javascript:/i)
    }
  })

  it('escapes what an owner chose, because an owner chose it', () => {
    const hostile = door({
      title: '<img src=x onerror="alert(1)">',
      door: '"><script>alert(2)</script>',
      summary: '<b>bold</b>',
      tags: ['<x>']
    })
    for (const page of [team(hostile), market([hostile]), home([hostile])]) {
      expect(page.body).not.toContain('<img src=x')
      expect(page.body).not.toContain('<script>alert')
      expect(page.body).not.toContain('<b>bold')
      expect(page.body).toContain('&lt;img')
    }
  })
})

describe('what a team’s page says', () => {
  it('names the door, the price and the rails — and the address to paste', () => {
    const page = team(door())
    expect(page.status).toBe(200)
    expect(page.body).toContain('COOKREW Alpha')
    expect(page.body).toContain('Pilot')
    expect(page.body).toContain('3 agents')
    expect(page.body).toContain('2.50 USD')
    expect(page.body).toContain('https://cookrew.dev/drej/cookrew-alpha')
    expect(page.body).toContain('USDC')
    expect(page.body).toContain('card')
  })

  it('carries what the line needs, and nothing that is not the owner’s to give', () => {
    const page = team(door({ summary: 'The crew that builds Cookrew.', tags: ['dev'], harnesses: ['Claude Code', 'Pi'] }))
    expect(page.body).toContain('data-door="@drej/cookrew-alpha"')
    expect(page.body).toContain('data-seal-key="MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab"')
    expect(page.body).toContain('The crew that builds Cookrew.')
    expect(page.body).toContain('Claude Code')
    expect(page.body).toContain('cookrew://')
    expect(page.body).toContain('/assets/line.js')
    expect(page.body).toContain('/assets/xterm.js')
  })

  it('never says where the author’s machine is', () => {
    const page = team(door({ transport: 'lan', address: 'http://192.168.2.40:8639/cookrew-alpha', sealKey: undefined }))
    expect(page.body).not.toContain('192.168')
    expect(page.body).not.toContain('8639')
    // And a door that is not on the relay gets no line: the button is disabled.
    expect(page.body).toContain('data-relayed="0"')
  })

  it('never lists the roster — one door is the whole interface', () => {
    const page = team(door({ agents: 9 }))
    expect(page.body).toContain('9 agents')
    expect(page.body).toContain('never listed')
  })

  it('a free door still says an account is needed', () => {
    const page = team(door({ access: 'account', priceUsd: undefined, rails: [] }))
    expect(page.body).toContain('free')
    expect(page.body).toContain('sign in')
    expect(page.body).not.toContain('2.50')
  })

  it('a door nobody serves answers like one that never existed', () => {
    const missing = team(null)
    expect(missing.status).toBe(404)
    expect(missing.body).toContain('Not serving')
    expect(missing.body).toContain('answer the same')
    expect(missing.headers['content-security-policy']).toContain("script-src 'none'")
  })

  it('shows the reader’s star and count', () => {
    const page = team(door(), { stars: 4, starred: true, account: 'mira' })
    expect(page.body).toContain('class="star on"')
    expect(page.body).toContain('★ <span>4</span>')
  })
})

describe('a listing is not a connection', () => {
  it('says so when a listed team is not actually there', () => {
    const page = team(door({ live: false }))
    expect(page.body).toContain('Not taking calls right now')
    expect(page.body).toContain('stays valid')
    expect(page.body).toContain('https://cookrew.dev/drej/cookrew-alpha')
    expect(page.body).toContain('data-live="0"')
  })

  it('says nothing extra when it IS there', () => {
    const page = team(door({ live: true }))
    expect(page.body).not.toContain('Not taking calls')
    expect(page.body).toContain('data-live="1"')
  })

  it('the header never contradicts the list under it', () => {
    const none = handlePage('drej', [door({ live: false })])
    expect(none.body).toContain('none taking calls right now')
    expect(none.body).not.toContain('1 team taking calls')

    const some = handlePage('drej', [door({ live: true }), door({ name: 'research', title: 'Research Crew', live: false })])
    expect(some.body).toContain('2 teams listed · 1 taking calls right now')

    const all = handlePage('drej', [door({ live: true })])
    expect(all.body).toContain('1 team taking calls')
  })

  it('the front page counts what is up, not what is listed', () => {
    const page = home([door({ live: true }), door({ name: 'b', live: false })])
    expect(page.body).toContain('Serving right now · 1')
  })

  it('marks the offline ones in a list', () => {
    const page = handlePage('drej', [door({ live: true }), door({ name: 'research', title: 'Research Crew', live: false })])
    // Exactly one row says offline: the one that is.
    expect(page.body.match(/class="off">offline</g)).toHaveLength(1)
  })
})

describe('an owner’s page', () => {
  it('lists what they serve, and links each one', () => {
    const page = handlePage('drej', [door(), door({ name: 'research', title: 'Research Crew' })])
    expect(page.body).toContain('@drej')
    expect(page.body).toContain('2 teams')
    expect(page.body).toContain('/drej/cookrew-alpha')
    expect(page.body).toContain('/drej/research')
  })

  it('a handle serving nothing looks like a handle nobody took', () => {
    const page = handlePage('nobody', [])
    expect(page.status).toBe(404)
    expect(page.body).toContain('never taken')
  })
})

describe('the front page', () => {
  it('leads with the claim, and shows what is actually serving', () => {
    const page = home([door()])
    expect(page.body).toContain('Run a team of AI coding agents on one canvas')
    expect(page.body).toContain('COOKREW Alpha')
    expect(page.body).toContain('Serving right now')
  })

  it('says so plainly when nobody is serving', () => {
    expect(home([]).body).toContain('Nobody is serving a team here yet')
  })

  it('names the real build, and says so when GitHub has not answered', () => {
    const page = home([door()])
    expect(page.body).toContain('https://x/dmg')
    expect(page.body).toContain('Cookrew-0.1.2-arm64.dmg')
    expect(page.body).toContain('v0.1.2')
    const cold = home([door()], null)
    expect(cold.body).not.toContain('v0.1.2')
    expect(cold.body).toContain('releases/latest')
    expect(cold.body).toContain('href="/download"')
  })

  it('shows the recorded cases, from the repository, with what was actually done', () => {
    const page = home([])
    expect(page.body).toContain('raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/qa-canvas.jpg')
    expect(page.body).toContain('● REC')
    expect(page.body).toContain('Dragged the Conductor rail up to checkpoint T13')
    expect(page.headers['content-security-policy']).toContain("img-src 'self' https://raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/")
    expect(page.headers['content-security-policy']).not.toContain('googleapis')
  })

  it('opens with the definition, carries the machine-readable head, and shows the live board', () => {
    const page = home([door({ live: true, harnesses: ['Pi'] })])
    expect(page.body).toContain('<h1>Run a team of AI coding agents on one canvas')
    expect(page.body).toContain('Cookrew is an open-source desktop workspace')
    expect(page.body).toContain('<meta name="description" content="Cookrew is an open-source desktop workspace')
    expect(page.body).toContain('<link rel="canonical" href="https://cookrew.dev/">')
    expect(page.body).toContain('property="og:image" content="https://raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/og-site.jpg"')
    expect(page.body).toContain('"@type":"SoftwareApplication"')
    expect(page.body).toContain('"@type":"FAQPage"')
    expect(page.body).toContain('2 lines opened today')
    expect(page.body).toContain('1 team serving now')
    expect(page.body).toContain('feat: the web line')
    expect(page.body).toContain('<table class="cmp">')
    expect(page.body).toContain('width="1400" height="875"')
    expect(page.body).toContain('qa-canvas-800.jpg 800w')
    expect(page.body).toContain('rel="preload" as="image" href="https://raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/qa-canvas-800.jpg"')
    expect(page.headers['content-security-policy']).toContain("manifest-src 'self'")
    expect(page.body).toContain('fetchpriority="high"')
  })

  it('never claims a cut of anyone’s money', () => {
    const flat = home([door()]).body.replace(/\s+/g, ' ')
    expect(flat).toContain('directly from caller to author')
    expect(flat).toContain('cookrew.dev takes no cut')
  })
})

describe('the market', () => {
  const doors = [
    door({ live: true, summary: 'The crew that builds Cookrew.', tags: ['dev'], harnesses: ['Claude Code', 'Pi'], seenAt: 5 }),
    door({ handle: 'mira', name: 'growth-desk', title: 'Growth Desk', door: 'Anchor', live: true, access: 'paid', rails: ['stripe'], seenAt: 9 }),
    door({ handle: 'lin', name: 'ledger', title: 'Ledger Close', door: 'Clerk', live: false, access: 'account', priceUsd: undefined, rails: [], seenAt: 2 })
  ]
  const titles = (body: string): string[] => [...body.matchAll(/class="ttl" href="\/[^"]+">([^<]+)</g)].map((m) => m[1])

  it('renders every listing with its search form, filters and a star', () => {
    const page = market(doors)
    expect(page.body).toContain('<form')
    expect(page.headers['content-security-policy']).toContain("form-action 'self'")
    expect(titles(page.body)).toEqual(['Growth Desk', 'COOKREW Alpha', 'Ledger Close'])
    expect(page.body).toContain('data-star="drej/cookrew-alpha"')
    expect(page.body).toContain('cookrew://import/@drej/cookrew-alpha')
    expect(page.body).toContain('The crew that builds Cookrew.')
    expect(page.body).toContain('3 teams')
  })

  it('searches the face: title, owner, door, summary, tags, harnesses', () => {
    expect(titles(market(doors, 'q=anchor').body)).toEqual(['Growth Desk'])
    expect(titles(market(doors, 'q=builds').body)).toEqual(['COOKREW Alpha'])
    expect(titles(market(doors, 'q=pi').body)).toEqual(['COOKREW Alpha'])
    expect(titles(market(doors, 'q=%40lin').body)).toEqual(['Ledger Close'])
    expect(titles(market(doors, 'owner=mira').body)).toEqual(['Growth Desk'])
    expect(market(doors, 'q=zzz').body).toContain('No team matches')
  })

  it('filters live, free, paid and rail; sorts by stars, recency and name', () => {
    expect(titles(market(doors, 'live=1').body)).toEqual(['Growth Desk', 'COOKREW Alpha'])
    expect(titles(market(doors, 'access=free').body)).toEqual(['Ledger Close'])
    expect(titles(market(doors, 'access=paid').body)).toEqual(['Growth Desk', 'COOKREW Alpha'])
    expect(titles(market(doors, 'rail=x402').body)).toEqual(['COOKREW Alpha'])
    expect(titles(market(doors, 'sort=recent').body)).toEqual(['Growth Desk', 'COOKREW Alpha', 'Ledger Close'])
    expect(titles(market(doors, 'sort=name').body)).toEqual(['COOKREW Alpha', 'Growth Desk', 'Ledger Close'])
    const starred = (h: string, n: string): number => (n === 'ledger' ? 7 : n === 'growth-desk' ? 2 : 0)
    expect(titles(market(doors, 'sort=stars', { stars: starred }).body)).toEqual(['Ledger Close', 'Growth Desk', 'COOKREW Alpha'])
  })

  it('the starred tab is the reader’s list, and asks a stranger to sign in', () => {
    expect(market(doors, 'tab=starred').body).toContain('Sign in to see what you starred')
    const mine = market(doors, 'tab=starred', { account: 'mira', starredTeams: ['lin/ledger'] })
    expect(titles(mine.body)).toEqual(['Ledger Close'])
    expect(mine.body).toContain('class="star on"')
    expect(mine.body).toContain('signed in as @mira')
  })

  it('presets are a second tab, reviewed in the app, never installed by a link', () => {
    const page = market(doors, 'tab=presets', {
      presets: [{ id: 'sha256:' + 'a'.repeat(64), name: 'Ship Crew', version: 4, author: 'drej', visibility: 'public', lineage: 'x', latestVersion: 4 }]
    })
    expect(page.body).toContain('Ship Crew')
    expect(page.body).toContain('/install/sha256:' + 'a'.repeat(64))
    expect(page.body).toContain('Review in Cookrew')
    expect(page.body).not.toContain('Growth Desk')
  })

  it('a malformed query falls to its defaults', () => {
    const q = marketQuery(new URLSearchParams('tab=hack&sort=drop&access=all&rail=cash&live=yes&owner=@Bad%20Guy'))
    expect(q).toEqual({ q: '', tab: 'teams', sort: 'stars', live: false, access: 'any', rail: 'any', owner: 'Bad Guy' })
  })
})

describe('a handle cannot capture a route', () => {
  it('reserves every top-level name the registry answers on', () => {
    for (const taken of ['v1', 'install', 'api', '.well-known', 'robots.txt', 'market', 'download', 'assets', 'features', 'start']) {
      expect(RESERVED_HANDLES.has(taken), taken).toBe(true)
    }
  })
})
