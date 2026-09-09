import { page, type Page } from './site-shell'

/**
 * THE THREE SENTENCES THE RELAY PATH CAN END IN.
 *
 * `/relay/@user/desktop/<id>/` is somewhere a PERSON is sent: the picker found
 * no direct path, chose the relay and called `location.assign`. So the three
 * ways it can refuse are pages with a way back, not JSON — a reader who lands
 * on a machine value has been told nothing and offered nothing.
 *
 * They are documents rather than app pages. Nothing here acts: the sign-in is
 * a link back to /me, which is where the sheet lives. A page that could open a
 * session would be a second admission ceremony, and the whole point of this
 * phase is that there is exactly one.
 */

/** The relay's own sentence, from the UI/UX note's copy table. */
export const RELAY_SENTENCE =
  'Via cookrew.dev relay — your Mac is not on this network. On the office Wi-Fi this goes direct.'

const wrap = (title: string, heading: string, lede: string, note: string, status: number): Page =>
  page(
    { title: `${title} — Cookrew`, kind: 'document', cache: 0, status, noindex: true },
    `<div class="wrap" style="padding-top:44px"><h1>${heading}</h1>
<p class="lede">${lede}</p>
<p class="meta">${note}</p>
<p class="row"><a class="btn lg" href="/me">Your desktops</a><a class="btn lg" href="/market">Marketplace</a></p></div>`
  )

/** Nobody is signed in. The account is what makes this address yours at all. */
export const relaySignInPage = (): Page =>
  wrap(
    'Sign in to reach your Mac',
    'Sign in first',
    'A relay session carries your own canvas, so cookrew.dev has to know it is you.',
    'Sign in on your account page, then open the Mac from the picker there.',
    401
  )

/**
 * The address is somebody else's. NOT-YOURS AND NOT-THERE READ THE SAME, so
 * this page cannot be used to find out whose desktops exist.
 */
export const relayNotYoursPage = (): Page =>
  wrap(
    'Not found',
    'Not found',
    'There is no Mac of yours at that address.',
    'Your own desktops are on your account page, with the path each one is reachable by right now.',
    404
  )

/**
 * ANOTHER SITE CAUSED THIS. Said as a page rather than a bare 403 because the
 * one person who ever sees it honestly is someone whose browser sent no
 * `Sec-Fetch-Site` and no `Origin` — and they deserve the way back.
 */
export const relayCrossSitePage = (): Page =>
  wrap(
    'Not from here',
    'Not from here',
    'That request came from another site, so it was not carried out.',
    'Open your Mac from your own account page, where the picker chooses the path for you.',
    403
  )

/** The desktop is not holding a line. Asleep, offline, or the app is not running. */
export const relayOfflinePage = (): Page =>
  wrap(
    'That Mac is not reachable',
    'Not reachable just now',
    'That Mac is not holding a relay session, so there is nothing here to carry your canvas.',
    'Wake it and leave Cookrew running, or open it from a network it is on — your Wi-Fi or your tailnet — and the picker goes direct.',
    503
  )
