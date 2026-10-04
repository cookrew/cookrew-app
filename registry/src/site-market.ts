import type { ListedDoor } from './site'
import type { PresetSummary } from './store'
import type { V2Seat } from './v2-seats'
import { presetCard } from './site-home'
import { esc, icon, page, type Page } from './site-shell'
import { MARKET_DEFINITION } from './site-content'
import { breadcrumbs, organization, teamList, webPage } from './site-seo'
import { cardFace, readerLine, seatAt, shelfOf, type CardFace, type Standing } from './market-shelf'

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
function teamCard(d: ListedDoor, stars: number, starred: boolean, standing: Standing, seat: V2Seat | null): string {
  const at = `/${esc(d.handle)}/${esc(d.name)}`
  const off = d.live === false
  const harnesses = d.harnesses ?? []
  const tags = d.tags ?? []
  const face = cardFace(standing, d, seat)
  const primary = face.primary.signin
    ? `<button class="btn sm primary" data-signin>${icon('key')} ${esc(face.primary.label)}</button>`
    : `<a class="btn sm primary" href="${esc(face.primary.href ?? at)}">${esc(face.primary.label)}</a>`
  return `<article class="team" data-standing="${esc(standing.kind)}">
<div class="head"><span class="led${off ? ' off' : ''}"></span><a class="ttl" href="${at}">${esc(d.title)}</a><span class="${chipClass(face.chip.tone)} stand">${esc(face.chip.label)}</span></div>
<div class="screen crt"><div class="l d">$ cookrew.dev/@${esc(d.handle)}/${esc(d.name)}</div><div class="l">${esc(d.door)}&gt; ${off ? 'offline — address stays valid' : `ready — one door, ${d.agents} behind it`}</div><div class="l d">${harnesses.length > 0 ? esc(harnesses.map((h) => h.toLowerCase()).join(' · ')) : `via ${esc(d.transport)}`}</div></div>
<div class="body">${d.summary ? `<p>${esc(d.summary)}</p>` : `<p class="dim">The owner has not written a summary.</p>`}<div class="row">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}<span class="chip violet">${esc(d.door)} answers</span><span class="chip">${d.agents} agent${d.agents === 1 ? '' : 's'}</span></div><div class="meta">by <a href="/${esc(d.handle)}">@${esc(d.handle)}</a> · ${esc(d.transport)}${d.access === 'paid' ? ' · ' + d.rails.map((r) => (r === 'x402' ? 'USDC · wallet' : 'card')).join(', ') : ''}</div>${face.note ? `<p class="meta note-line">${esc(face.note)}</p>` : ''}</div>
<div class="foot"><button class="star${starred ? ' on' : ''}" data-star="${esc(d.handle)}/${esc(d.name)}" title="one star per account">★ <span>${stars}</span></button><span class="sp"></span>${primary}<a class="btn sm" href="${at}#open" data-open="cookrew://import/@${esc(d.handle)}/${esc(d.name)}">In Cookrew</a></div>
</article>`
}

function chip(name: string, value: string, label: string, on: boolean): string {
  return `<label><input type="checkbox" name="${name}" value="${value}"${on ? ' checked' : ''}><span class="chip">${label}</span></label>`
}

/**
 * WHO IS SHOPPING. Signed in: the name and what it holds, with the account
 * page a click away. Signed out: the one sentence that explains why signing
 * in is worth it, and the sheet.
 */
function readerStrip(input: MarketInput, line: string | null): string {
  if (input.account === null || line === null) {
    return `<div class="who" data-signin-stays><span class="meta">Sign in once — your seats, stars and teams follow your username to any device, and into the app.</span><button class="btn sm primary" data-signin>${icon('key')} Sign in</button></div>`
  }
  return `<div class="who"><span class="chip amber">${esc(line)}</span><span class="meta">A seat bought here is the seat the app opens with — same username, no second sign-in.</span><a class="btn sm" href="/me">Your account</a></div>`
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
  const tab = (key: MarketTab, label: string): string =>
    `<a class="${query.tab === key ? 'on' : ''}" href="/market?tab=${key}${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}">${label}</a>`
  const hidden = (name: string, value: string): string =>
    value ? `<input type="hidden" name="${name}" value="${esc(value)}">` : ''
  const card = (d: ListedDoor): string =>
    teamCard(
      d,
      input.stars(d.handle, d.name),
      starred.has(`${d.handle}/${d.name}`),
      shelf.standing.get(`${d.handle}/${d.name}`) ?? { kind: 'stranger' },
      input.account === null ? null : seatAt(d, seats, input.now)
    )
  // The shelf is the reader's own: it shows on the teams tab only, where the
  // whole market is on the page. A search or the starred tab is a question
  // about the catalogue, and the answer lists every match once.
  const shelved = query.tab === 'teams' && !query.q && !query.owner && shelf.yours.length > 0
  const catalogue = shelved ? shelf.rest : doors
  const count =
    query.tab === 'presets'
      ? `${presets.length} preset${presets.length === 1 ? '' : 's'}`
      : `${catalogue.length} ${shelved ? 'more ' : ''}team${catalogue.length === 1 ? '' : 's'}`
  const yours = shelved
    ? `<section class="shelf" id="yours"><h2 class="mkt-h">Yours<span class="chip amber">${shelf.yours.length} to open</span></h2><div class="teams">${shelf.yours.map(card).join('')}</div></section>`
    : ''
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
            ? `<div class="empty">Everything listed is already yours.</div>`
            : `<div class="empty">No team matches. Widen the filters, or serve one yourself.</div>`
  const reader = input.account === null ? null : readerLine(input.account, shelfOf(input.doors, input.account, seats, input.now), input.starredTeams.length)

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
    `<div class="wrap" style="padding-top:36px">
<p class="kicker"><span class="no">MARKET</span>one account · a seat once · any device</p>
<h1 style="font-size:clamp(28px,3.6vw,40px);margin-bottom:10px">Find a crew. Open it, or buy a seat.</h1>
<p class="lede" style="margin-bottom:8px">${esc(MARKET_ONE_LINE)}</p>
${readerStrip(input, reader)}
<div class="tabs">${tab('teams', 'Served teams')}${tab('presets', 'Presets to download')}${tab('starred', '★ Starred')}</div>
<form class="card soft" style="padding:14px 16px" method="get" action="/market" id="filters">
${hidden('tab', query.tab === 'teams' ? '' : query.tab)}${hidden('owner', query.owner)}
<div class="toolbar"><input type="search" name="q" id="q" value="${esc(query.q)}" placeholder="search teams, owners, harnesses, tags…" autocomplete="off">
<select name="sort" id="sort"><option value="stars"${query.sort === 'stars' ? ' selected' : ''}>Most starred</option><option value="recent"${query.sort === 'recent' ? ' selected' : ''}>Recently served</option><option value="name"${query.sort === 'name' ? ' selected' : ''}>Name</option></select>
<button class="btn" type="submit">Search</button></div>
<div class="filters">
${chip('live', '1', '● live now', query.live)}
${chip('access', 'free', 'free', query.access === 'free')}
${chip('access', 'paid', 'paid', query.access === 'paid')}
${chip('rail', 'x402', 'USDC · x402', query.rail === 'x402')}
${chip('rail', 'stripe', 'card · stripe', query.rail === 'stripe')}
${query.owner ? `<a class="chip amber" href="/market">@${esc(query.owner)} ✕</a>` : ''}
</div></form>
${yours}
<p class="meta" id="count" style="margin:16px 0 10px">${count}${query.q ? ` matching “${esc(query.q)}”` : ''}${query.owner ? ` by @${esc(query.owner)}` : ''}${input.account ? ` · signed in as @${esc(input.account)}` : ''}</p>
${grid}
<div class="faq" style="margin-top:24px" id="account"><details><summary>How listings, seats, stars and opening work</summary><ul class="pts how">
<li><b>One account.</b> Your cookrew.dev username is the only identity here. What you serve, the seats you hold, your stars and what the app opens all follow it — there is no handle to enrol and no key to mint.</li>
<li><b>A listing.</b> In the app: save a team, press SERVE, sign the registration. The registry lists the address you gave it, verbatim, and marks it live only while your relay downlink is up.</li>
<li><b>A seat.</b> A priced team charges a seat once, at its own door; it is yours on any device you sign in on. Money goes from you to the author — cookrew.dev takes no cut.</li>
<li><b>A star.</b> One per account per team. Stars sort this page; they never gate anything.</li>
<li><b>Opening.</b> “In Cookrew” fires a <code>cookrew://import/@owner/team</code> link; the app, signed in as you, shows the import sheet, meets the gate, and the orch card lands. Nothing is installed by a link alone.</li>
</ul></details></div>
</div>`
  )
}
