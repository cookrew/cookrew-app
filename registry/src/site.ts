import type { DoorRecord } from './doors'
import { esc, page, type Page } from './site-shell'
import { doorRow } from './site-home'

export { homePage } from './site-home'
export { marketPage, marketQuery, filterDoors } from './site-market'
export { teamPage } from './site-team'
export type { Page } from './site-shell'

/**
 * A door as a PAGE sees it: the record, plus whether anyone is actually
 * holding it open right now.
 *
 * The two are genuinely different facts and the pages used to show only the
 * first, which meant a team stayed advertised while its author's laptop had
 * been shut since Tuesday. `live` is computed per request from the relay's own
 * connection table — never stored, because a stored one would be the same
 * stale claim with an extra step.
 */
export type ListedDoor = DoorRecord & { live?: boolean }

/**
 * THE PUBLIC FACE OF cookrew.dev — four pages, one shell (site-shell.ts).
 *
 *   /               the homepage                     site-home.ts    document
 *   /market         search, filters, stars           site-market.ts  app
 *   /<handle>       an owner's page                  here            document
 *   /<handle>/<t>   a served team's page + the line  site-team.ts    app
 *
 * Nothing here is hand-maintained, because the thing it describes changes
 * every time somebody serves a team — a page written by hand would be wrong
 * by the afternoon.
 */

/**
 * Top-level names a handle may never take.
 *
 * An owner's page lives at /<handle>, so a handle called `v1` would shadow the
 * API and one called `market` the market. Reserved here rather than at
 * registration alone, so an old record that predates a new route still cannot
 * capture it.
 */
export const RESERVED_HANDLES = new Set([
  'v1',
  'api',
  'install',
  'assets',
  'static',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  '.well-known',
  'about',
  'pricing',
  'docs',
  'help',
  'terms',
  'privacy',
  'login',
  'signup',
  'admin',
  'market',
  'download',
  'features',
  'start',
  'llms.txt',
  'site.webmanifest',
  'favicon.svg'
])

/** AN OWNER'S PAGE — who they are, and what they are serving. */
export function handlePage(handle: string, doors: readonly ListedDoor[], stars: (h: string, n: string) => number = () => 0): Page {
  if (doors.length === 0) {
    return page(
      { title: `${handle} — Cookrew`, kind: 'document', cache: 0, status: 404 },
      `<div class="wrap" style="padding-top:44px"><h1>@${esc(handle)}</h1>
<p class="lede">Nobody by that name is serving a team here.</p>
<p class="meta">A handle with nothing served looks exactly like a handle that
was never taken — that is deliberate, so this page cannot be used to find out
who has an account.</p></div>`
    )
  }
  // THE HEADER MUST NOT CONTRADICT THE LIST BELOW IT. "1 team taking calls"
  // over a team marked offline is two answers to one question on one screen,
  // and the reader has no way to know which to believe.
  const up = doors.filter((d) => d.live !== false).length
  const total = doors.length
  const line =
    up === total
      ? `${total} team${total === 1 ? '' : 's'} taking calls.`
      : up === 0
        ? `${total} team${total === 1 ? '' : 's'} listed · none taking calls right now.`
        : `${total} teams listed · ${up} taking calls right now.`
  return page(
    { title: `${handle} — Cookrew`, kind: 'document', active: 'market' },
    `<div class="wrap" style="padding-top:44px"><p class="meta"><a href="/market">Marketplace</a> / @${esc(handle)}</p>
<h1>@${esc(handle)}</h1>
<p class="lede">${line}</p>
<ul class="doors">${doors.map((d) => doorRow(d, stars(d.handle, d.name))).join('')}</ul>
<p class="row" style="margin-top:18px"><a class="btn" href="/market?owner=${esc(handle)}">All of @${esc(handle)}’s teams in the market →</a></p></div>`
  )
}
