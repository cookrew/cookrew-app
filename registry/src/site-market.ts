import type { ListedDoor } from './site'
import type { PresetSummary } from './store'
import { presetCard, priceChip } from './site-home'
import { esc, page, type Page } from './site-shell'
import { MARKET_DEFINITION } from './site-content'
import { breadcrumbs, organization, teamList, webPage } from './site-seo'

/**
 * THE MARKET — doors first, presets second, stars as the sort key.
 *
 * Search, filters and sort are ordinary GET parameters rendered on the server,
 * so the page is complete and correct with script disabled; the one script it
 * loads turns the star buttons into a passkey ceremony and "Open in Cookrew"
 * into a deep link. A listing is a team somebody is serving from their own
 * machine; the registry lists it, marks it live only while its relay downlink
 * is up, and never rewrites what the owner published.
 */

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

function teamCard(d: ListedDoor, stars: number, starred: boolean): string {
  const at = `/${esc(d.handle)}/${esc(d.name)}`
  const off = d.live === false
  const harnesses = d.harnesses ?? []
  const tags = d.tags ?? []
  return `<article class="team">
<div class="head"><span class="led${off ? ' off' : ''}"></span><a class="ttl" href="${at}">${esc(d.title)}</a><span class="chip">${d.agents} AGENT${d.agents === 1 ? '' : 'S'}</span></div>
<div class="screen crt"><div class="l d">$ cookrew.dev/@${esc(d.handle)}/${esc(d.name)}</div><div class="l">${esc(d.door)}&gt; ${off ? 'offline — address stays valid' : `ready — one door, ${d.agents} behind it`}</div><div class="l d">${harnesses.length > 0 ? esc(harnesses.map((h) => h.toLowerCase()).join(' · ')) : `via ${esc(d.transport)}`}</div></div>
<div class="body">${d.summary ? `<p>${esc(d.summary)}</p>` : `<p class="dim">The owner has not written a summary.</p>`}<div class="row">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}<span class="chip violet">${esc(d.door)} answers</span><span class="chip">${esc(d.transport)}</span></div><div class="meta">by <a href="/${esc(d.handle)}">@${esc(d.handle)}</a>${d.access === 'paid' ? ' · ' + d.rails.map((r) => (r === 'x402' ? 'USDC · wallet' : 'card')).join(', ') : ''}</div></div>
<div class="foot">${priceChip(d)}<span class="sp"></span><button class="star${starred ? ' on' : ''}" data-star="${esc(d.handle)}/${esc(d.name)}" title="one star per account">★ <span>${stars}</span></button><a class="btn sm" href="${at}">Page</a><a class="btn sm primary" href="${at}#open" data-open="cookrew://import/@${esc(d.handle)}/${esc(d.name)}">Open in Cookrew</a></div>
</article>`
}

function chip(name: string, value: string, label: string, on: boolean): string {
  return `<label><input type="checkbox" name="${name}" value="${value}"${on ? ' checked' : ''}><span class="chip">${label}</span></label>`
}

export function marketPage(input: MarketInput): Page {
  const { query } = input
  const doors = filterDoors(input)
  const presets =
    query.tab === 'presets'
      ? input.presets.filter((p) => !query.q || `${p.name} ${p.author}`.toLowerCase().includes(query.q.toLowerCase()))
      : []
  const starred = new Set(input.starredTeams)
  const tab = (key: MarketTab, label: string): string =>
    `<a class="${query.tab === key ? 'on' : ''}" href="/market?tab=${key}${query.q ? `&q=${encodeURIComponent(query.q)}` : ''}">${label}</a>`
  const hidden = (name: string, value: string): string =>
    value ? `<input type="hidden" name="${name}" value="${esc(value)}">` : ''
  const count =
    query.tab === 'presets'
      ? `${presets.length} preset${presets.length === 1 ? '' : 's'}`
      : `${doors.length} team${doors.length === 1 ? '' : 's'}`
  const grid =
    query.tab === 'presets'
      ? presets.length > 0
        ? `<div class="teams">${presets.map(presetCard).join('')}</div>`
        : `<div class="empty">No preset matches.</div>`
      : doors.length > 0
        ? `<div class="teams">${doors
            .map((d) => teamCard(d, input.stars(d.handle, d.name), starred.has(`${d.handle}/${d.name}`)))
            .join('')}</div>`
        : query.tab === 'starred' && !input.account
          ? `<div class="empty">Sign in to see what you starred.</div>`
          : `<div class="empty">No team matches. Widen the filters, or serve one yourself.</div>`

  return page(
    {
      title: 'Marketplace — served AI agent teams you can open from a browser · Cookrew',
      kind: 'app',
      active: 'market',
      scripts: ['site.js'],
      cache: 0,
      description: MARKET_DEFINITION.slice(0, 158),
      path: '/market',
      noindex: query.tab === 'starred',
      jsonLd: [organization(), webPage({ path: '/market', name: 'Cookrew marketplace', description: MARKET_DEFINITION }), breadcrumbs([{ name: 'Cookrew', path: '/' }, { name: 'Marketplace', path: '/market' }]), teamList(query.tab === 'teams' ? doors : [])]
    },
    `<div class="wrap" style="padding-top:44px">
<p class="kicker"><span class="no">MARKET</span>doors, not copies</p>
<h1 style="font-size:clamp(28px,3.6vw,40px)">Find a crew. Star it. Open it in Cookrew.</h1>
<p class="lede">${esc(MARKET_DEFINITION)}</p>
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
<p class="meta" id="count" style="margin:16px 0 10px">${count}${query.q ? ` matching “${esc(query.q)}”` : ''}${query.owner ? ` by @${esc(query.owner)}` : ''} · ${input.account ? `signed in as @${esc(input.account)}` : 'not signed in — stars need an account'}</p>
${grid}
<div class="grid" style="margin-top:36px" id="account">
<div class="card"><h3>How a listing gets here</h3><p>In the app: save a team, press SERVE, sign the registration with your passkey. The registry lists the address you gave it, verbatim, and marks it live only while your relay downlink is up.</p></div>
<div class="card"><h3>What a star means</h3><p>One per account per team, signed with the same passkey that publishes. Stars sort this page; they never gate anything.</p></div>
<div class="card"><h3>What opening does</h3><p>“Open in Cookrew” fires a <code>cookrew://import/@owner/team</code> link. The app shows the import sheet first, then the gate answers 401 · 402 · 403, then the orch card lands. Nothing is installed by a link alone.</p></div>
</div>
</div>`
  )
}
