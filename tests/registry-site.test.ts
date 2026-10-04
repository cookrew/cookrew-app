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
const homeInput = (doors: ListedDoor[] = [], rel: Release | null = release): Parameters<typeof homePage>[0] => ({
  doors,
  presets: [{ id: 'sha256:' + 'a'.repeat(64), name: 'Ship Crew', version: 4, author: 'drej', visibility: 'public', lineage: 'x', latestVersion: 4 }],
  release: rel,
  stars,
  pulse: () => ({ lines: 2, calls: 9 }),
  linesToday: 2
})
const home = (doors: ListedDoor[], rel: Release | null = release) => homePage(homeInput(doors, rel))
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
    // the page never lists them: no roster markup, only the door's name and a count
    expect(page.body).not.toMatch(/class="roster|<ul class="agents/)
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
    expect(page.body).toContain('1 serving now')
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
    expect(page.body).toContain('Open someone’s canvas — nothing to install')
  })

  // WHAT A VISITOR CAME FOR IS IN THE FIRST SCREEN. Two things: a canvas and
  // the marketplace. The hero's buttons are the first, the dock under it is
  // the second, and neither is a scroll — so both are asserted to land before
  // the page's first section starts.
  it('puts a canvas and the marketplace in the first screen, before any section', () => {
    const body = home([door()]).body
    const at = (marker: string): number => {
      const i = body.indexOf(marker)
      expect(i, marker).toBeGreaterThan(-1)
      return i
    }
    const firstSection = at('<section id="market">')
    expect(at('id="download"')).toBeLessThan(firstSection)
    expect(at('<nav class="dock')).toBeLessThan(firstSection)
    // the dock's three cells: what the canvas is, the reader's own machines,
    // and the market with a count rather than an adjective.
    const dock = body.slice(at('<nav class="dock'), body.indexOf('</nav>', at('<nav class="dock')))
    expect(dock).toContain('href="/features/ai-agents-on-one-canvas"')
    expect(dock).toContain('href="/me#desktops"')
    expect(dock).toContain('href="/market"')
    expect(dock).toMatch(/1 listed · \d+ taking calls/)
  })

  // A PAID INSTANCE IS THE ONE THING HERE SOMEBODY DECIDES ABOUT IN A SECOND,
  // so it gets its own heading above the free ones, with the price on the card.
  it('gives the instances you can rent their own heading, ahead of the free ones', () => {
    const body = home([door()]).body
    expect(body).toContain('Instances you can rent')
    expect(body).toContain('id="rent"')
    expect(body.indexOf('id="rent"')).toBeLessThan(body.indexOf('<section id="start">'))
    // The price buys a SEAT (ruled copy G1: "charges {price} a seat"), not a
    // session — the old chip said the thing the money rung no longer does.
    expect(body).toContain('USD · a seat')
    expect(body).not.toContain('per session')
    // and nothing pretends there is a rent shelf when every team is free
    expect(home([{ ...door(), access: 'account' as const, priceUsd: undefined }]).body).not.toContain('Instances you can rent')
  })

  it('says so plainly when nobody is serving', () => {
    expect(home([]).body).toContain('Nobody is serving a team here yet')
  })

  it('names the real build, and says so when GitHub has not answered', () => {
    const page = home([door()])
    expect(page.body).toContain('https://x/dmg')
    expect(page.body).toContain('v0.1.2')
    const cold = home([door()], null)
    expect(cold.body).not.toContain('v0.1.2')
    expect(cold.body).toContain('releases/latest')
    expect(cold.body).toContain('href="/download"')
  })

  it('shows the recorded cases, from the repository, with what was actually done', () => {
    const page = home([])
    // the hero is the promo now — the shipped App on the Dev board, ten seconds, from the repository like every frame
    expect(page.body).toContain('raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/promo.mp4')
    expect(page.body).toContain('<video autoplay muted loop playsinline')
    expect(page.headers['content-security-policy']).toContain('media-src https://raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/')
    expect(page.body).toContain('● REC')
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
    expect(page.body).toContain('"@type":"ItemList"')
    expect(page.body).toContain('2 lines opened today')
    expect(page.body).toContain('1 serving now')
    expect(page.body).toContain('Ship Crew')
    expect(page.body).toContain('href="/install/sha256:' + 'a'.repeat(64) + '"')
    expect(page.body).toContain('width="1400" height="874"')
    expect(page.body).toContain('rel="preload" as="image" href="https://raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/promo-poster.jpg"')
    expect(page.headers['content-security-policy']).toContain("manifest-src 'self'")
    expect(page.body).toContain('poster="https://raw.githubusercontent.com/cookrew/cookrew-app/dev/registry/assets/site/promo-poster.jpg"')
  })

  /**
   * ONE PAGE, TOP TO BOTTOM (owner ruling, 2026-09-06): the download, then
   * GET STARTED, then the FEATURES, then the market. The header's three
   * buttons are anchors into it.
   */
  it('is the three pages in one, in the order of what a visitor came for', () => {
    const body = home([door()]).body
    const at = (marker: string): number => {
      const i = body.indexOf(marker)
      expect(i, marker).toBeGreaterThan(-1)
      return i
    }
    // The market leads, because opening somebody's canvas needs no install;
    // the two steps and the features follow for the reader who keeps going.
    expect(at('id="download"')).toBeLessThan(at('<section id="market">'))
    expect(at('<section id="market">')).toBeLessThan(at('<section id="start">'))
    expect(at('<section id="start">')).toBeLessThan(at('<section id="features">'))
    // The download links sit under the headline, with the version beside them.
    expect(body.indexOf('https://x/dmg')).toBeLessThan(body.indexOf('<section id="market">'))
    // GET STARTED: the two steps and the commands the orch runs — as text,
    // because the front page stays a document with no script (see below).
    expect(body).toContain('Place an agent, and let it orchestrate your workflow')
    expect(body).toContain('id="crew-commands"')
    expect(body).toContain('$ cookrew orch "Forge"')
    expect(body).not.toContain('/assets/site.js')
    expect(body).toContain('"@type":"HowTo"')
    // The sections are the page's own catalog, on the right rail; the header
    // keeps HOME, the market and the account, and nothing that used to be a page.
    const rail = body.slice(body.indexOf('<aside class="toc"'), body.indexOf('</aside>'))
    for (const href of ['#start', '#features', '#market']) expect(rail).toContain(`href="${href}"`)
    // the rail is sticky, so the two destinations ride down the page with it
    expect(rail).toContain('href="https://x/dmg"')
    expect(rail).toContain('href="/market"')
    expect(body.indexOf('<div class="home-body">')).toBeLessThan(body.indexOf('<aside class="toc"'))
    const header = body.slice(body.indexOf('<nav class="top">'), body.indexOf('</nav>'))
    expect(header).toContain('href="/"')
    expect(header).toContain('href="/market"')
    expect(header).toContain('Sign in')
    // the app is one click from every page, and the header is sticky
    expect(header).toContain('href="/#download"')
    expect(header).not.toContain('Features')
    expect(header).not.toContain('Get started')
    expect(header).not.toContain('github.com')
    expect(body).not.toContain('href="/start"')
    expect(body).not.toContain('href="/features"')
  })

  it('introduces every feature with its recorded frame, and says what each thing can do', () => {
    const body = home([]).body
    // Every frame in the grid is a card face, and the stylesheet knows the
    // class: the only other img rule is scoped to figure.shot.
    const faces = body.match(/<a class="card-shot" href="\/features\/[^"]+"><img /g) ?? []
    expect(faces.length).toBeGreaterThan(0)
    expect(body).toContain('.card-shot img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover')
    expect(body).toContain('<div class="grid shots">')
    const flat = body.replace(/\s+/g, ' ')
    expect(flat).toContain('<table class="cmp">')
    expect(flat).toContain('directly from caller to author')
    expect(flat).toContain('cookrew.dev takes no cut')
  })

  it('shows the latest commits when GitHub answered, and nothing when it did not', () => {
    const commits = [{ sha: 'abc1234', title: 'fix: the board', url: 'https://github.com/x/y/commit/abc1234', date: '2026-09-06' }]
    expect(homePage({ ...homeInput(), commits }).body).toContain('<code>abc1234</code>')
    expect(home([]).body).not.toContain('<ol class="commits">')
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

/**
 * THE PURCHASABLE INSTANCES ARE ON THE FIRST SCREEN (owner, 2026-09-27), and
 * a team page has ONE way to buy: the seat bar. The gate card inside the
 * terminal is a status, and the line's own entry stays hidden behind it.
 */
describe('the rent strip and the one buy control', () => {
  const paidDoors = [door(), door({ name: 'b', title: 'B' }), door({ name: 'c', title: 'C' }), door({ name: 'd', title: 'D' })]

  it('puts up to three priced instances under the hero, each with a buy link, and points at the rest', () => {
    const body = home(paidDoors).body
    const strip = body.slice(body.indexOf('<div class="rent-strip"'), body.indexOf('<nav class="dock'))
    expect(strip).toContain('Instances you can rent')
    expect(strip.match(/<article class="rent/g)).toHaveLength(3)
    expect(strip.match(/\?buy=1"/g)).toHaveLength(3)
    expect(strip).toContain('href="/drej/cookrew-alpha?buy=1">Buy a seat · $2.50')
    expect(strip).toContain('href="/market?access=paid">+1 more')
    // the strip is before the dock and the first section — the first screen
    expect(body.indexOf('<div class="rent-strip"')).toBeLessThan(body.indexOf('<nav class="dock'))
    expect(body.indexOf('<nav class="dock')).toBeLessThan(body.indexOf('<section id="market">'))
    // a priced team appears ONCE on the page: the market section lists only what the strip did not
    const market = body.slice(body.indexOf('<section id="market">'), body.indexOf('<section id="start">'))
    expect(market).not.toContain('Instances you can rent')
    expect(market).not.toContain('COOKREW Alpha')
    // still a document: the strip is anchors, no script
    expect(body).not.toMatch(/<script(?! type="application\/ld\+json")/i)
  })

  it('shows the free ones when nothing is priced, and says so when nothing is listed', () => {
    const free = home([door({ access: 'account', priceUsd: undefined, rails: [] })]).body
    expect(free).toContain('Free to open')
    expect(free).not.toContain('?buy=1')
    expect(free).toContain('href="/drej/cookrew-alpha">Open')
    const none = home([]).body
    expect(none).toContain('Nobody is serving a team here yet')
    expect(none).toContain('href="#serve"')
  })

  it('the market card offers the seat for a priced team to a signed-in reader, the sheet to a stranger', () => {
    const doors = [door(), door({ name: 'f', title: 'F', access: 'account', priceUsd: undefined, rails: [] })]
    const signedIn = market(doors, '', { account: 'mira' }).body
    expect(signedIn).toContain('href="/drej/cookrew-alpha?buy=1">Buy a seat · $2.50')
    expect(signedIn).not.toContain('href="/drej/f?buy=1"')
    const stranger = market(doors).body
    expect(stranger).not.toContain('?buy=1')
    expect(stranger).toContain('Sign in to buy · $2.50')
    expect(stranger).toContain('<details><summary>How listings, seats, stars and opening work')
  })

  it('a team page has exactly one buy control, in the seat bar, and the gate card has no button', () => {
    const unseated = team(door(), { account: 'mira' }).body
    expect(unseated.match(/Buy a seat/g)).toHaveLength(1)
    expect(unseated).toContain('id="seat-buy"')
    expect(unseated).toContain('A seat first — buy one above, or ask @drej.')
    expect(unseated).toMatch(/<button class="btn primary" id="btn-open" hidden>/)
    for (const body of [
      team(door(), { account: 'mira', seat: { id: 's1', team: '@drej/cookrew-alpha', account: 'mira', source: 'granted', by: 'drej', createdAt: 1 } }).body,
      team(door(), { account: 'drej', owner: true }).body,
      team(door({ access: 'account', priceUsd: undefined, rails: [] }), { account: 'mira' }).body
    ]) {
      expect(body).not.toContain('Buy a seat')
      expect(body).toContain('data-seat-open')
    }
    // offline beats the standing: the status says so, and the hidden entry is disabled
    const off = team(door({ live: false }), { account: 'mira' }).body
    expect(off).toContain('id="gate-h">Not serving right now<')
    expect(off).toContain('id="btn-open" hidden disabled>')
  })

  it('keeps every element line.js and site.js read', () => {
    const body = team(door(), { account: 'mira' }).body
    for (const id of ['team', 'phase', 'state', 'strip-opened', 'gate', 'gate-h', 'gate-p', 'gate-actions', 'btn-open', 'btn-new', 'btn-end', 'bar-led', 'prompt', 'send', 'term', 'rail', 'rail-n', 'rail-tail', 'block', 'seatbar', 'seat-head', 'seat-ask-note', 'seat-buy', 'star', 'addr', 'led', 'livetxt', 'overlay', 'open']) {
      expect(body, id).toContain(`id="${id}"`)
    }
    for (const hook of ['data-seat-buy', 'data-seat-ask', 'data-open=', 'data-copy=', 'data-star=', 'data-door=', 'data-seal-key=', 'data-relayed=', 'data-price=', 'data-orch=', 'data-live=', 'data-access=']) {
      expect(body, hook).toContain(hook)
    }
    // the owner's bar is the line and a count — seats are managed in the app (owner, 2026-10-04)
    const owner = team(door(), { account: 'drej', owner: true, seats: [] }).body
    expect(owner).toContain('data-seat-open')
    for (const id of ['seat-username', 'seat-list', 'seat-grant']) expect(owner, id).not.toContain(`id="${id}"`)
    expect(team(door(), { account: null }).body).toContain('data-signin')
  })
})

describe('the market is a shop with one name on the door', () => {
  const doors = [
    door({ live: true, seenAt: 5 }),
    door({ handle: 'mira', name: 'growth-desk', title: 'Growth Desk', door: 'Anchor', live: true, access: 'paid', priceUsd: '4', rails: ['stripe'], seenAt: 9 }),
    door({ handle: 'lin', name: 'ledger', title: 'Ledger Close', door: 'Clerk', live: false, access: 'account', priceUsd: undefined, rails: [], seenAt: 2 })
  ]
  const seat = { id: 's1', team: '@drej/cookrew-alpha', account: 'mira', source: 'bought' as const, by: 'stripe', createdAt: 1 }
  const titles = (body: string): string[] => [...body.matchAll(/class="ttl" href="\/[^"]+">([^<]+)</g)].map((m) => m[1])

  it('offers a stranger the account sheet on every card, and never a handle to enrol', () => {
    const page = market(doors).body
    expect(page).toContain('Sign in to buy · $2.50')
    expect(page).toContain('Sign in to open')
    expect(page.match(/data-signin/g)?.length).toBeGreaterThanOrEqual(4)
    expect(page).not.toContain('Enrol')
    expect(page).not.toContain('id="yours"')
    expect(page).not.toContain('Buy a seat')
    // A sign-in from here reloads the market for the reader (site.js).
    expect(page).toContain('data-signin-stays')
  })

  it('puts what the reader holds on a shelf, and prices the rest by their standing', () => {
    const page = market(doors, '', { account: 'mira', seats: [seat] }).body
    const shelf = page.slice(page.indexOf('id="yours"'), page.indexOf('id="count"'))
    expect(titles(shelf)).toEqual(['Growth Desk', 'COOKREW Alpha'])
    expect(shelf).toContain('Yours · you serve it')
    expect(shelf).toContain('Seated · bought')
    expect(shelf.match(/>Open</g)).toHaveLength(2)
    const rest = page.slice(page.indexOf('id="count"'))
    expect(titles(rest)).toEqual(['Ledger Close'])
    expect(rest).toContain('1 more team')
    expect(rest).toContain('Free · yours to open')
    expect(page).toContain('@mira · 1 seat · 1 team served · 0 starred')
    expect(page).not.toContain('data-signin>')
  })

  it('sends an unseated reader to buy, and keeps every match once under a search', () => {
    const page = market(doors, '', { account: 'lin' }).body
    expect(page).toContain('href="/drej/cookrew-alpha?buy=1">Buy a seat · $2.50')
    expect(page).toContain('href="/mira/growth-desk?buy=1">Buy a seat · $4')
    expect(page).toContain('Yours · you serve it')
    const searched = market(doors, 'q=ledger', { account: 'lin' }).body
    expect(searched).not.toContain('id="yours"')
    expect(titles(searched)).toEqual(['Ledger Close'])
  })
})
