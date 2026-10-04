import type { ListedDoor } from './site'
import type { PresetSummary } from './store'
import type { V2Seat } from './v2-seats'
import { presetCard } from './site-home'
import { esc, icon, page, type Page } from './site-shell'
import { MARKET_DEFINITION } from './site-content'
import { breadcrumbs, organization, teamList, webPage } from './site-seo'
import { cardFace, readerLine, seatAt, shelfOf, type CardFace, type Shelf, type Standing } from './market-shelf'

/**
 * THE MARKET — a shop with one name on the door.
 *
 * The reader's cookrew.dev USERNAME is the only identity the market knows
 * (market-shelf.ts): it decides what every card is to them — theirs, seated,
 * free to open, for sale — and what the one button on it does. A reader who
 * holds something sees it first, on a shelf above the catalogue; a reader who
 * is signed out sees the prices and one way in, the account sheet. Nothing
 * here asks for a handle, a key or a second credential: signing in is the
 * whole ceremony, and a seat bought here is the seat the app opens with.
 *
 * Search, filters and sort are GET parameters rendered on the server, so the
 * page is complete with script disabled; the script makes the star buttons
 * and "In Cookrew" act, and both act as the same account.
 */

/** The definition's first sentence — the lede; the rest is in the FAQ below the grid. */
const MARKET_ONE_LINE = MARKET_DEFINITION.slice(0, MARKET_DEFINITION.indexOf('. ') + 1)

export type MarketTab = 'teams' | 'presets' | 'starred'
export type MarketSort = 'stars' | 'recent' | 'name'

export interface MarketQuery {
  q: string
  tab: MarketTab
  sort: MarketSort
  live: boolean
  access: 'any' | 'free' | 'paid'
  rail: 'any' | 'x402' | 'stripe'
  owner: string
}

export interface MarketInput {
  doors: readonly ListedDoor[]
  presets: readonly PresetSummary[]
  query: MarketQuery
  stars: (handle: string, name: string) => number
  /** Signed-in account, when the request carried one; null for a stranger. */
  account: string | null
  /** Teams the account starred, `handle/name`. */
  starredTeams: readonly string[]
  /** Every seat the account holds, anywhere. Empty for a stranger. */
  seats?: readonly V2Seat[]
  now?: number
}

/** Read a market query from URL parameters; anything odd falls to its default. */
export function marketQuery(params: URLSearchParams): MarketQuery {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(key) ?? ''
    return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  }
  return {
    q: (params.get('q') ?? '').trim().slice(0, 120),
    tab: pick('tab', ['teams', 'presets', 'starred'], 'teams'),
    sort: pick('sort', ['stars', 'recent', 'name'], 'stars'),
    live: params.get('live') === '1',
    access: pick('access', ['any', 'free', 'paid'], 'any'),
    rail: pick('rail', ['any', 'x402', 'stripe'], 'any'),
    owner: (params.get('owner') ?? '').replace(/^@/, '').trim().slice(0, 32)
  }
}

/** The door's searchable text — everything the owner published, lowercased. */
function haystack(door: ListedDoor): string {
  return [door.title, door.handle, door.name, door.door, door.summary ?? '', ...(door.tags ?? []), ...(door.harnesses ?? [])]
    .join(' ')
    .toLowerCase()
}

export function filterDoors(input: MarketInput): ListedDoor[] {
  const { query } = input
  const needle = query.q.toLowerCase().replace(/^@/, '')
  const starred = new Set(input.starredTeams)
  const kept = input.doors.filter((d) => {
    if (query.tab === 'starred' && !starred.has(`${d.handle}/${d.name}`)) return false
    if (query.owner && d.handle !== query.owner) return false
    if (needle && !haystack(d).includes(needle)) return false
    if (query.live && d.live === false) return false
    if (query.access === 'free' && d.access !== 'account') return false
    if (query.access === 'paid' && d.access !== 'paid') return false
    if (query.rail !== 'any' && !d.rails.includes(query.rail)) return false
    return true
  })
  const stars = (d: ListedDoor): number => input.stars(d.handle, d.name)
  return kept.sort((a, b) => {
    if (query.sort === 'name') return a.title.localeCompare(b.title)
    if (query.sort === 'recent') return b.seenAt - a.seenAt
    return stars(b) - stars(a) || b.seenAt - a.seenAt || a.title.localeCompare(b.title)
  })
}

const chipClass = (tone: CardFace['chip']['tone']): string => (tone === 'plain' ? 'chip' : `chip ${tone}`)

/**
 * A listing, for this reader. The head carries what the team is to them; the
 * foot carries the one thing they can do about it, beside the star and the
 * app. `?buy=1` on the team page starts the purchase there (line.js).
 */
function teamCard(d: ListedDoor, standing: Standing, seat: V2Seat | null): string {
  const at = `/${esc(d.handle)}/${esc(d.name)}`
  const off = d.live === false
  const face = cardFace(standing, d, seat)
  const primary = face.primary.signin
    ? `<button class="btn primary" data-signin>${icon('key')} ${esc(face.primary.label)}</button>`
    : `<a class="btn primary" href="${esc(face.primary.href ?? at)}">${esc(face.primary.label)}</a>`
  return `<article class="team" data-standing="${esc(standing.kind)}">
<div class="head"><span class="led${off ? ' off' : ''}"></span><a class="ttl" href="${at}">${esc(d.title)}</a><span class="${chipClass(face.chip.tone)} stand">${esc(face.chip.label)}</span></div>
<div class="screen crt"><div class="l d">$ cookrew.dev/@${esc(d.handle)}/${esc(d.name)}</div><div class="l">${esc(d.door)}&gt; ${off ? 'offline — address stays valid' : `ready — ${d.agents} agent${d.agents === 1 ? '' : 's'} behind the door`}</div></div>
<div class="body"><p>${d.summary ? esc(d.summary) : `<span class="dim">by @${esc(d.handle)}</span>`}</p></div>
<div class="foot">${primary}</div>
</article>`
}

/**
 * YOUR AGENTS — the first thing a signed-in reader sees (owner, 2026-10-04:
 * from the market, once signed in, pick the agents you control).
 *
 * One row per team the reader serves or holds a seat at, newest seat first,
 * and one act per row: OPEN THE LINE goes to the team's page with `?open=1`,
 * which line.js spends on the click's behalf — the line opens on arrival,
 * because the click here WAS the open. Rows, not cards, so five fit on a
 * phone above the catalogue. A reader with nothing yet is told so in one
 * line and pointed below.
 */
function yoursStrip(input: MarketInput, shelf: Shelf, seats: readonly V2Seat[], line: string): string {
  if (input.account === null) return ''
  const head = `<div class="yours-head"><span class="chip amber">${esc(line)}</span><h2>Your agents</h2></div>`
  if (shelf.yours.length === 0) {
    return `<section class="yours" id="yours">${head}<p class="meta yours-empty">Nothing of yours yet — a seat you buy below lands here, and so does a team you serve from the app.</p></section>`
  }
  const rows = shelf.yours
    .map((d) => {
      const at = `/${esc(d.handle)}/${esc(d.name)}`
      const standing = shelf.standing.get(`${d.handle}/${d.name}`) ?? { kind: 'stranger' as const }
      const face = cardFace(standing, d, seatAt(d, seats, input.now))
      const off = d.live === false
      return `<li class="yours-row" data-standing="${esc(standing.kind)}"><span class="led${off ? ' off' : ''}"></span><a class="ttl" href="${at}">${esc(d.title)}</a><span class="meta">${esc(d.door)} · ${d.agents} agent${d.agents === 1 ? '' : 's'}${off ? ' · offline' : ''}</span><span class="${chipClass(face.chip.tone)} stand">${esc(face.chip.label)}</span><a class="btn sm primary" href="${at}?open=1">Open</a></li>`
    })
    .join('')
  return `<section class="yours" id="yours">${head}<ul class="yours-rows">${rows}</ul></section>`
}

export function marketPage(input: MarketInput): Page {
  const { query } = input
  const doors = filterDoors(input)
  const seats = input.seats ?? []
  const shelf = shelfOf(doors, input.account, seats, input.now)
  const presets =
    query.tab === 'presets'
      ? input.presets.filter((p) => !query.q || `${p.name} ${p.author}`.toLowerCase().includes(query.q.toLowerCase()))
      : []
  const starred = new Set(input.starredTeams)
  const card = (d: ListedDoor): string =>
    teamCard(d, shelf.standing.get(`${d.handle}/${d.name}`) ?? { kind: 'stranger' }, input.account === null ? null : seatAt(d, seats, input.now))
  // The strip is the reader's own, and shows where the whole market is on the
  // page; a search or another tab is a question about the catalogue, and the
  // answer lists every match once.
  const onYourTab = query.tab === 'teams' && !query.q && !query.owner
  const shelved = onYourTab && shelf.yours.length > 0
  const catalogue = shelved ? shelf.rest : doors
  const grid =
    query.tab === 'presets'
      ? presets.length > 0
        ? `<div class="teams">${presets.map(presetCard).join('')}</div>`
        : `<div class="empty">No preset matches.</div>`
      : catalogue.length > 0
        ? `<div class="teams">${catalogue.map(card).join('')}</div>`
        : query.tab === 'starred' && !input.account
          ? `<div class="empty">Sign in to see what you starred.</div>`
          : shelved
            ? `<div class="empty">Everything listed is already yours — it is all above.</div>`
            : `<div class="empty">No team matches${query.q ? ` “${esc(query.q)}”` : ''}. Try another word, or serve one yourself.</div>`
  const whole = shelfOf(input.doors, input.account, seats, input.now)
  const reader = input.account === null ? '' : readerLine(input.account, whole, input.starredTeams.length)
  const starredNote = query.tab === 'starred' && input.account ? `<p class="meta">${starred.size} starred by @${esc(input.account)}</p>` : ''

  return page(
    {
      title: 'Marketplace — served AI agent teams you can open from a browser · Cookrew',
      kind: 'app',
      active: 'market',
      account: input.account,
      scripts: ['device-id.js', 'site.js'],
      cache: 0,
      description: MARKET_DEFINITION.slice(0, 158),
      path: '/market',
      noindex: query.tab === 'starred',
      jsonLd: [organization(), webPage({ path: '/market', name: 'Cookrew marketplace', description: MARKET_DEFINITION }), breadcrumbs([{ name: 'Cookrew', path: '/' }, { name: 'Marketplace', path: '/market' }]), teamList(query.tab === 'teams' ? doors : [])]
    },
    `<div class="wrap market" data-signin-stays>
<h1>Find a crew. Open it, or buy a seat.</h1>
<p class="lede">${esc(MARKET_ONE_LINE)}</p>
${onYourTab ? yoursStrip(input, whole, seats, reader) : ''}
<form class="finder" method="get" action="/market"><input type="search" name="q" id="q" value="${esc(query.q)}" placeholder="search teams, owners, harnesses, tags…" autocomplete="off" aria-label="Search the marketplace"></form>
${starredNote}
${grid}
</div>`
  )
}
