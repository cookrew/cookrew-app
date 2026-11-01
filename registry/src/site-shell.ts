import type { ServerResponse } from 'node:http'
import { ASSET_VERSION } from './assets-bundle'
import { BRAND_MARK_SVG } from './site-brand'
import { GITHUB_REPO, SITE_ORIGIN } from './site-content'
import { jsonLd } from './site-seo'
import { webCopy } from './v3-copy'

/**
 * THE SITE'S ONE SHELL — cookrew.dev in the app's own dress.
 *
 * Every page on cookrew.dev is generated from what the registry already knows
 * and wears the app's chrome: cream header with a 2px ink rule, square
 * corners, hard bevel shadows, pixel labels, phosphor screens. One stylesheet,
 * one header, one footer; a second copy of any of them would drift.
 *
 * TWO KINDS OF PAGE, told apart by their CSP.
 *
 *   document  the front page and an owner's page. No script, no form handler,
 *             no external fetch: a document cannot express "open this for
 *             me", and must not pretend to.
 *   app       the market and a team's page. They act — a star is a passkey
 *             ceremony, the line is a terminal — so they load exactly one
 *             script from this origin and may talk only to this origin.
 *             Everything a link may never do (install, pay, open a session)
 *             is still one deliberate click after the facts are on screen.
 *
 * Fonts are the ink theme's two webfonts (JetBrains Mono, Inter; the serif is the reader's own), served
 * from this origin out of the bundle; recorded frames come from this
 * repository on GitHub, pinned to the commit the bundle was built from, so the
 * bundle stays small enough for its ConfigMap and no third party is in the
 * critical path.
 */

declare const __SITE_REF__: string | undefined
/** The git ref the bundle was built from (esbuild --define), else the dev branch. */
const SITE_REF = typeof __SITE_REF__ === 'string' && /^[0-9a-f]{7,40}$/.test(__SITE_REF__) ? __SITE_REF__ : 'dev'
/**
 * Where the site's heavy assets live: this repository, at the exact commit
 * the bundle was built from. Frames and fonts never enter the bundle (the
 * ConfigMap has a ceiling) and never come from a third party's origin — one
 * origin besides our own, and it is ours.
 */
declare const __SITE_ASSETS__: string | undefined
/**
 * A LOCAL PREVIEW ONLY: a build may point the frames at a static server over
 * registry/assets (esbuild --define:__SITE_ASSETS__), so frames recorded and
 * not yet pushed can be judged on the real page. The deployed bundle never
 * sets it; the CSP follows whichever origin this names.
 */
const PREVIEW_ASSETS = typeof __SITE_ASSETS__ === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(__SITE_ASSETS__) ? __SITE_ASSETS__ : null
export const SITE_ASSETS = PREVIEW_ASSETS ?? `https://raw.githubusercontent.com/cookrew/cookrew-app/${SITE_REF}/registry/assets/`
export const SITE_FRAMES = `${SITE_ASSETS}site/`
/** The fonts are small enough to travel inside the bundle; they are served from here. */
export const SITE_FONTS = '/assets/'
export { GITHUB_REPO, SITE_ORIGIN } from './site-content'

/** W1 — one sheet, two tabs. Register is sign-in plus a confirmation. */
/**
 * W4 · THE JOIN LEDE TRAVELS AS DATA, not as a second copy inside site.js.
 *
 * The CSP forbids an inline script, and the assets are plain JS that cannot
 * import from v3-copy.ts — so a sentence the script needs either comes down
 * in the markup or gets written out again by hand. Written again is the drift
 * the one copy table exists to stop, so it comes down here and the script
 * reads it off the element.
 */
export const ACCOUNT_SHEET = `<dialog id="account-sheet" class="card acct" aria-label="Your cookrew.dev account" data-join-lede="${esc(webCopy('w4.join-lede'))}" data-asked-lede="${esc(webCopy('w4.asked'))}" data-join-refused="${esc(webCopy('w4.join-refused'))}">
<form method="dialog" id="account-form">
<div class="acct-tabs" role="tablist">
<button class="btn sm primary" type="button" role="tab" aria-selected="true" data-acct-tab="signin">Sign in</button>
<button class="btn sm" type="button" role="tab" aria-selected="false" data-acct-tab="register">Register</button>
</div>
<p class="meta" id="acct-lede">A username and a password. The site never asks for an email.</p>
<label class="acct-row" id="acct-username-row"><span>Username</span>
<input id="acct-username" name="username" autocomplete="username" spellcheck="false" maxlength="32" placeholder="mira">
<em class="chip" id="acct-username-note" hidden></em></label>
<label class="acct-row" id="acct-password-row"><span>Password</span>
<input id="acct-password" name="password" type="password" autocomplete="current-password" maxlength="256">
<em class="chip" id="acct-password-note" hidden></em></label>
<label class="acct-row" id="acct-code-row" hidden><span>Code</span>
<input id="acct-code" name="code" autocomplete="one-time-code" spellcheck="false" maxlength="9" placeholder="K7M2-P9XR">
<em class="chip" id="acct-code-note" hidden></em></label>
<label class="acct-row" id="acct-confirm-row" hidden><span>Confirm</span>
<input id="acct-confirm" name="confirm" type="password" autocomplete="new-password" maxlength="256">
<em class="chip" id="acct-confirm-note" hidden></em></label>
<p class="meta" id="acct-message" role="status"></p>
<div class="row">
<button class="btn primary" id="acct-submit" value="go">Continue</button>
<button class="btn" value="cancel" formnovalidate>Cancel</button>
</div>
<p class="meta" id="acct-foot">Forgot it? Any of your devices can let you in; or a recovery code.</p>
<p class="meta" id="acct-join-offer">${esc(webCopy('w4.join-offer'))}
<button class="btn sm" type="button" data-acct-mode="join">Join with a code</button></p>
<p class="meta" id="acct-join-back" hidden>
<button class="btn sm" type="button" data-acct-mode="signin">Use a username and password instead</button></p>
</form>
</dialog>`

export type PageKind = 'document' | 'app'

const CSP: Record<PageKind, string> = {
  document: `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; manifest-src 'self'; img-src 'self' ${SITE_FRAMES} data:; media-src ${SITE_FRAMES}; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  app: `default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; img-src 'self' ${SITE_FRAMES} data:; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
}

/**
 * THE STRATA SHELL (/me, level 0) is an app page that also frames: the dive
 * into an agent's terminal embeds the desktop's own companion, which this
 * origin serves through the relay prefix — so 'self' and nothing wider.
 */
export const STRATA_SHELL_CSP = `${CSP.app}; frame-src 'self'`

/**
 * A HANDFUL OF NAMED ORIGINS, and never a wildcard.
 *
 * An app page whose script has to reach somewhere that is not this origin says
 * WHICH somewhere, and the policy names them one by one. They are spelled out
 * rather than opened with `https:` because such a page is rendered for one
 * reader and we know exactly which addresses it will try; a wildcard would let
 * anything that ever gets a script onto the page reach anywhere.
 *
 * No page asks for one today: /me stopped probing desktops directly when the
 * badge became a single question to cookrew.dev itself. It comes back in phase
 * C3, when a Mac's addresses have names a browser will trust.
 */
const withConnect = (policy: string, connect: readonly string[]): string =>
  connect.length === 0 ? policy : policy.replace("connect-src 'self'", `connect-src 'self' ${connect.join(' ')}`)

export interface Page {
  status: number
  headers: Record<string, string>
  body: string
}

/** "5 Sep 2026" — a date a person reads, in the site's one format. */
export const day = (at: number): string =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** Escape for HTML text AND for a double-quoted attribute — one function. */
export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface ShellOptions {
  title: string
  kind: PageKind
  /** One sentence for the snippet and the share card; ≤ 160 characters is what engines show. */
  description?: string
  /** The canonical path of this page, e.g. `/market`. Absent means no canonical. */
  path?: string
  /** An absolute image URL for the share card; the site's own when absent. */
  image?: string
  /** schema.org blocks for one JSON-LD graph. */
  jsonLd?: readonly Record<string, unknown>[]
  /** Images to preload (the hero's), absolute or site-relative. */
  preload?: readonly string[]
  /** Pages that must not be indexed — a 404, a page rendered for one reader. */
  noindex?: boolean
  /** Which header button is lit. */
  active?: 'home' | 'market' | 'features' | 'start' | 'download'
  /** Scripts from /assets, app pages only. */
  scripts?: string[]
  /** Stylesheets from /assets, app pages only. */
  styles?: string[]
  /** Extra origins this page's script may fetch — app pages only, spelled out. */
  connect?: readonly string[]
  /**
   * Cache lifetime in seconds; 0 for pages that must not be cached. A page
   * rendered for a signed-in reader is never shared: 0 means private/no-store.
   */
  cache?: number
  status?: number
  /**
   * WHO IS READING, when the server knows. The header names them and links to
   * /me; absent or null, it offers sign in. A DOCUMENT page has no script and
   * so no other way to ever learn this — the front page said "Sign in" to a
   * person who was, for as long as this field did not exist. A page rendered
   * with an account is rendered for one reader: its caller sets `cache: 0`.
   */
  account?: string | null
}

export function page(options: ShellOptions, main: string): Page {
  return {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        options.kind === 'app' ? withConnect(CSP.app, options.connect ?? []) : CSP.document,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Everything here describes mutable state — a team can be served or
      // withdrawn between two refreshes — so it is cached briefly or not at all.
      ...(options.cache === 0
        ? { 'cache-control': 'private, no-store', vary: 'cookie' }
        : { 'cache-control': `public, max-age=${options.cache ?? 60}` })
    },
    body: shell(options, main)
  }
}

/** A 404 that is a document: a crawler following a stale link reads a page, not JSON. */
export function notFoundPage(what: string): Page {
  return page(
    { title: 'Not found — Cookrew', kind: 'document', cache: 0, status: 404, noindex: true },
    `<div class="wrap" style="padding-top:44px"><h1>Not found</h1><p class="lede">There is no ${esc(what)} at that address.</p><p class="row"><a class="btn" href="/">Home</a><a class="btn" href="/market">Marketplace</a><a class="btn" href="/#features">Features</a></p></div>`
  )
}

/** A generated document, with the headers that make it inert. */
export function respondPage(response: ServerResponse, rendered: Page): void {
  const payload = Buffer.from(rendered.body, 'utf8')
  response.writeHead(rendered.status, {
    ...rendered.headers,
    'content-length': String(payload.byteLength)
  })
  response.end(payload)
}

/** The header mark: the ink lockup (site-brand.ts), still. */
const LOGO = BRAND_MARK_SVG

/** The app's four fonts, from the bundle; `optional` because a font that arrives late must not shift the page — they are preloaded, so it rarely does. */
const FONT_FACES = `
@font-face{font-family:'Inter';font-style:normal;font-weight:400 700;font-display:optional;src:url(${SITE_FONTS}inter.woff2?v=${ASSET_VERSION}) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400 700;font-display:optional;src:url(${SITE_FONTS}jetbrains-mono.woff2?v=${ASSET_VERSION}) format('woff2')}`
const PRECONNECT = `<link rel="preconnect" href="https://raw.githubusercontent.com" crossorigin><link rel="preload" as="font" type="font/woff2" href="${SITE_FONTS}inter.woff2?v=${ASSET_VERSION}" crossorigin>`

function head(options: ShellOptions): string {
  const url = options.path === undefined ? null : `${SITE_ORIGIN}${options.path}`
  const description = options.description ?? ''
  const image = options.image ?? `${SITE_FRAMES}og-site.jpg`
  return [
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${esc(options.title)}</title>`,
    description ? `<meta name="description" content="${esc(description)}">` : '',
    options.noindex ? `<meta name="robots" content="noindex">` : '',
    url ? `<link rel="canonical" href="${esc(url)}">` : '',
    `<meta property="og:site_name" content="Cookrew"><meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(options.title)}">`,
    description ? `<meta property="og:description" content="${esc(description)}">` : '',
    url ? `<meta property="og:url" content="${esc(url)}">` : '',
    `<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(options.title)}">`,
    description ? `<meta name="twitter:description" content="${esc(description)}">` : '',
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="theme-color" content="#f4efe4" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#15130f" media="(prefers-color-scheme: dark)">`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="manifest" href="/site.webmanifest">`,
    `<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">`,
    PRECONNECT,
    (options.preload ?? []).map((href) => `<link rel="preload" as="image" href="${esc(href)}">`).join(''),
    options.jsonLd && options.jsonLd.length > 0 ? jsonLd(options.jsonLd) : ''
  ].join('')
}

function shell(options: ShellOptions, main: string): string {
  // HOME, the MARKET, the app and the account. The two things a visitor came
  // for — the canvas and the marketplace — are one click from every page, and
  // the header is sticky, so they never scroll to find them again. The
  // homepage's sections are its own catalog, on the right rail (site-home.ts);
  // GitHub is in the footer with the rest of the outbound links.
  const nav = [
    ['/', 'Home', 'home'],
    ['/market', 'Marketplace', 'market'],
    ['/#download', 'Get the app', 'download']
  ]
    .map(
      ([href, label, key]) =>
        `<a class="btn sm${options.active === key ? ' primary' : ''}" href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`
    )
    .join('')
  // The reader, when the request said who they were. An app page keeps the
  // button (site.js turns `me` into a visit to /me); a document page, which
  // may run nothing, is a link — and it is the ONLY way the front page can
  // ever name the person reading it.
  const who = options.account ?? null
  const account =
    who !== null
      ? options.kind === 'app'
        ? `<button class="btn sm" id="signin" data-signin="me">@${esc(who)}</button>`
        : `<a class="btn sm" href="/me">@${esc(who)}</a>`
      : options.kind === 'app'
        ? `<button class="btn sm" id="signin" data-signin>${icon('key')} Sign in</button>`
        : `<a class="btn sm" href="/market#account">${icon('key')} Sign in</a>`
  // The ladder's screens travel with the account sheet: every page that
  // carries site.js is a page a second factor can be asked on.
  const scripts = (options.kind === 'app' ? options.scripts ?? [] : [])
    .flatMap((s) => (s === 'site.js' ? [s, 'factors.js'] : [s]))
    .map((s) => `<script src="/assets/${esc(s)}?v=${ASSET_VERSION}" defer></script>`)
    .join('')
  const styles = (options.kind === 'app' ? options.styles ?? [] : [])
    .map((s) => `<link rel="stylesheet" href="/assets/${esc(s)}?v=${ASSET_VERSION}">`)
    .join('')
  return `<!doctype html>
<html lang="en"><head>${head(options)}${styles}<style>${FONT_FACES}${SITE_STYLE}${ACCOUNT_STYLE}</style>${scripts}</head>
<body>
<header class="hdr"><div class="wrap">
<a class="mark" href="/" aria-label="Cookrew home">${LOGO}</a>
<span class="chip">an open-source spatial workspace for AI agents</span>
<nav class="top">${nav}${account}</nav>
</div></header>
${main}
<footer><div class="wrap">
<nav class="row" aria-label="Site"><a href="/market">Marketplace</a><a href="/#features">Features</a><a href="/#start">Get started</a><a href="/#download">Download</a><a href="${GITHUB_REPO}">Source</a><a href="${GITHUB_REPO}/releases">Releases</a><a href="/v1/doors">Directory as data</a><a href="/sitemap.xml">Sitemap</a><a href="/llms.txt">llms.txt</a></nav>
<p class="meta" style="margin-top:12px">Cookrew is open source under the MIT license. Every page here is generated from the registry's live directory; nothing is staged, and every number carries its date.</p>
</div></footer>
<div class="toast" id="toast" hidden></div>
${options.kind === 'app' ? ACCOUNT_SHEET : ''}
</body></html>`
}


/**
 * THE ICONS. One family, drawn here: 12 px on a 16-unit grid, a 1.8 stroke in the button's own
 * colour, round caps. Buttons used to carry Unicode glyphs (⬇ ◳ ▶) and one colour emoji (🔑); those
 * rendered in whatever font the reader happened to have, at four different weights. A button's
 * icon should be as certain as its border.
 */
const ICONS: Readonly<Record<string, string>> = {
  download: '<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10"/>',
  market: '<path d="M2.5 6.5h11l-1 6.5h-9zM4 6.5 5.5 3h5L12 6.5M6 9.5h4"/>',
  play: '<path d="M4.5 3.2v9.6L12.5 8z"/>',
  key: '<circle cx="5.5" cy="8" r="3"/><path d="M8.5 8h5M11.5 8v2.5M13.5 8v1.8"/>',
  canvas: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6.5 6.5v7"/>',
  mac: '<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5 13.5h6M8 11v2.5"/>',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>'
}
export function icon(name: keyof typeof ICONS): string {
  return `<svg class="ic" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}

/** One stylesheet for every document; a second would drift from the first. */
export const SITE_STYLE = `
:root{--cream:#f4efe4;--cream-hi:#fbf8f1;--cream-md:#ebe3d3;--cream-lo:#e3d9c6;--ink:#1d1a16;--ink-soft:#5d554a;
--muted:#6f675b;--dim:#8c8374;--line:rgba(29,26,22,.42);--line-soft:rgba(29,26,22,.16);--hair:rgba(29,26,22,.16);--amber:#e2b866;--amber-soft:#f3e4c2;--amber-deep:#8f5520;
--seal:#a8692b;--seal-fill:#96592a;--on-seal:#fbf8f1;--wash:rgba(168,140,98,.16);
--phos:#ece4d2;--phos-dim:#9a917f;--phos-glow:#e2b866;--phos-bg:#1d1a16;--hp:#5f8a4c;--rose:#c0392b;--violet:#7d6a9a;--violet-hi:#d9d0e8;
--note-bg:#f2e6bf;--lift:0 1px 2px rgba(40,30,15,.06),0 10px 28px rgba(40,30,15,.1);--lift-sm:0 1px 2px rgba(40,30,15,.06),0 3px 10px rgba(40,30,15,.07);
--font-pixel:'JetBrains Mono','SF Mono',Menlo,monospace;--font-screen:'JetBrains Mono','SF Mono',Menlo,monospace;
--font-serif:'Iowan Old Style','Palatino Linotype',Palatino,'Songti SC','STSong',Georgia,serif;
--font-mono:'JetBrains Mono','SF Mono',Menlo,monospace;--font-body:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--cream:#15130f;--cream-hi:#211e18;--cream-md:#1d1a15;--cream-lo:#27231c;--ink:#ece4d2;
--ink-soft:#b3a993;--muted:#9a917f;--dim:#6f6859;--line:rgba(236,228,210,.38);--line-soft:rgba(236,228,210,.16);--hair:rgba(236,228,210,.16);
--amber:#d6a24e;--amber-soft:#3a2f1c;--amber-deep:#d49a5a;--seal:#c88a47;--seal-fill:#c88a47;--on-seal:#15130f;--wash:rgba(200,160,100,.1);
--phos-bg:#0f0d0a;--hp:#7fae6a;--rose:#e06a55;--violet:#a593c9;--violet-hi:#3e3558;--note-bg:#362e18;
--lift:0 1px 2px rgba(0,0,0,.3),0 12px 32px rgba(0,0,0,.4);--lift-sm:0 1px 2px rgba(0,0,0,.3),0 4px 12px rgba(0,0,0,.3)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}[hidden]{display:none!important}
body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.6 var(--font-body);-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px}
/* header — the app's own chrome: cream-hi, 2px ink rule */
.hdr{position:sticky;top:0;z-index:50;background:var(--cream-hi);border-bottom:1px solid var(--hair)}
.hdr .wrap{display:flex;align-items:center;gap:14px;min-height:56px;flex-wrap:wrap;padding-top:8px;padding-bottom:8px}
@media (max-width:760px){.hdr .wrap>.chip{display:none}.hdr nav.top{margin-left:0;width:100%}}
.mark{display:flex;align-items:center;gap:9px;text-decoration:none;font:700 15px var(--font-pixel);letter-spacing:.12em}
.mark-coo{width:42px;height:31px;display:block;flex:0 0 auto;overflow:visible;color:var(--ink)}

nav.top{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.chip{font:8.5px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);background:var(--cream-md);border:1px solid var(--line);padding:2px 6px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.chip.amber{background:var(--amber);color:var(--ink)}.chip.violet{background:var(--violet);color:var(--on-seal)}.chip.rose{background:var(--rose);color:var(--on-seal)}
.chip.busy{background:var(--amber-soft);animation:blink 1.1s steps(2) infinite}
.btn{font:9.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;color:var(--ink);background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift-sm);padding:7px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;text-decoration:none;user-select:none}
@media (prefers-color-scheme:dark){.btn{color:var(--ink)}.btn.primary{color:var(--ink)}}
.btn:hover{background:var(--amber-soft)}.btn:active{transform:translateY(1px)}
.btn .ic{flex:0 0 auto;margin:-1px 0}.btn.sm .ic{width:10px;height:10px}.btn.lg .ic{width:13px;height:13px}
.dock .ico .ic{width:16px;height:16px;stroke-width:1.6}
.btn.primary{background:var(--amber)}.btn.lg{font-size:11px;padding:11px 16px;box-shadow:var(--lift-sm)}
.btn.sm{padding:3px 8px;font-size:8.5px;box-shadow:none}.btn[disabled]{opacity:.35;pointer-events:none}
.btn.danger{background:var(--rose);color:var(--on-seal)}
.led{width:10px;height:10px;border-radius:50%;border:1px solid var(--line);background:var(--hp);box-shadow:0 0 6px rgba(107,190,88,.8);flex:0 0 auto;display:inline-block}
.led.off{background:var(--dim);box-shadow:none}.led.busy{background:var(--amber);box-shadow:0 0 8px rgba(255,214,0,.9);animation:blink .9s steps(2) infinite}
@keyframes blink{50%{opacity:.35}}
/* type */
h1{font-size:clamp(30px,4.6vw,52px);line-height:1.1;letter-spacing:-.02em;margin:0 0 18px}
h2{font:700 clamp(20px,2.6vw,30px)/1.2 var(--font-body);letter-spacing:-.01em;margin:0 0 10px}
h3{font-size:16px;margin:0 0 6px}
.kicker{font:700 9.5px var(--font-pixel);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin:0 0 10px;display:flex;gap:10px;align-items:center}
.kicker .no{background:var(--amber);color:var(--ink);padding:1px 6px;border:1px solid var(--line)}
.lede{font-size:clamp(17px,1.6vw,20px);color:var(--muted);max-width:62ch;margin:0 0 22px}
p{max-width:70ch}.muted{color:var(--muted)}.dim{color:var(--dim)}
code,.mono{font-family:var(--font-mono);font-size:.88em}
.cmd{display:block;background:var(--phos-bg);color:var(--phos);font:15px/1.45 var(--font-screen);padding:14px 16px;border:1px solid var(--hair);box-shadow:var(--lift);overflow-x:auto;white-space:pre;margin:14px 0}
.cmd .c{color:var(--phos-dim)}
/* cards — square corners, hard bevel */
.card{background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift);padding:18px 20px}
.card.soft{box-shadow:var(--lift-sm)}
.note{background:var(--note-bg);border:1px solid var(--hair);box-shadow:var(--lift-sm);padding:12px 14px;font-size:14px;transform:rotate(-.6deg)}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid .card p{color:var(--muted);font-size:14.5px;margin:0}
/* a frame as a card's face (the features index): a 16:10 window onto the
   top-left of the recording, never the image at its own pixel size — the
   only img rule above is scoped to figure.shot, and a 1400px frame dropped
   bare into a 260px card painted as a tall cropped strip. */
.grid.shots{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.card-shot{display:block;background:var(--phos-bg);border-bottom:1px solid var(--hair)}
.card-shot img{display:block;width:100%;height:auto;aspect-ratio:16/10;object-fit:cover;object-position:left top}
/* CRT screen (phosphor) */
.crt{background:var(--phos-bg);color:var(--phos);font:15px/1.25 var(--font-screen);position:relative;border:1px solid var(--hair);box-shadow:var(--lift);overflow:hidden}
.crt::before{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,rgba(255,255,255,.03) 0,rgba(255,255,255,.03) 1px,transparent 1px,transparent 3px)}
/* recorded frame */
figure.shot{margin:0;border:1px solid var(--hair);box-shadow:var(--lift);background:var(--phos-bg);overflow:hidden}
figure.shot img,figure.shot video{display:block;width:100%;height:auto}
figure.shot video{aspect-ratio:1400/874;background:var(--phos-bg)}
figure.shot figcaption{font-size:13px;color:var(--muted);padding:9px 12px;background:var(--cream-hi);border-top:1px solid var(--hair);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
figure.shot .rec{font:8.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;background:var(--hp);color:var(--on-seal);border:1px solid var(--line);padding:2px 6px}
figure.shot.missing{min-height:220px;display:grid;place-items:center;color:var(--phos-dim);font:18px var(--font-screen)}
/* sections */
section{padding:56px 0;border-bottom:1px solid var(--line-soft)}
.feature{display:grid;gap:34px;grid-template-columns:minmax(0,5fr) minmax(0,7fr);align-items:center}
.feature.flip>.text{order:2}
@media (max-width:860px){.feature{grid-template-columns:1fr}.feature.flip>.text{order:0}}
ul.pts{padding-left:18px;margin:10px 0;color:var(--muted);font-size:15px}ul.pts li{margin:4px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
/* directory rows */
ul.doors{list-style:none;padding:0;margin:0;border:1px solid var(--hair);box-shadow:var(--lift);background:var(--cream-hi)}
ul.doors li{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line-soft)}
ul.doors li:last-child{border-bottom:none}
.ttl{font-weight:700;font-size:17px;text-decoration:none}.meta{color:var(--muted);font-size:13.5px}
.price{font:600 12px var(--font-mono);border:1px solid var(--line);padding:2px 9px;color:var(--ink-soft)}
.star{font:600 12px var(--font-mono);border:1px solid var(--hair);background:var(--cream-hi);box-shadow:var(--lift-sm);padding:4px 9px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;color:var(--ink)}
.star.on{background:var(--amber);color:var(--ink)}.star:active{transform:translateY(1px)}
footer{padding:36px 0 60px;color:var(--muted);font-size:13.5px;border-top:1px solid var(--line-soft)}
footer nav a{font:8.5px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;text-decoration:none;border:1px solid var(--line-soft);padding:3px 7px}
.stats{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.stat{border:1px solid var(--hair);background:var(--cream-hi);box-shadow:var(--lift-sm);padding:14px}
.stat b{display:block;font:700 30px/1 var(--font-pixel);letter-spacing:-.02em;margin-bottom:6px;color:var(--amber-deep)}
.stat span{font-size:13px;color:var(--muted)}
/* market — one finder (tabs, search, filters, sort) above the grid; nothing before the first card
   that is not a way to narrow it. The reader strip sits under the headline and folds on a phone. */
.finder{margin:18px 0 14px}.finder input[type=search]{width:100%;box-sizing:border-box;font:15px var(--font-mono);padding:10px 12px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink);box-shadow:var(--lift-sm);outline:none}.finder input[type=search]:focus{background:var(--amber-soft)}
.market h1{font-size:clamp(28px,3.6vw,40px);margin-bottom:8px}.market .lede{margin-bottom:6px}
.toolbar{display:flex;gap:8px;align-items:center;margin:0 0 10px}
.toolbar input[type=search]{flex:1;min-width:0;font:15px var(--font-mono);padding:9px 12px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink);box-shadow:var(--lift-sm);outline:none}
.toolbar input[type=search]:focus{background:var(--amber-soft)}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.filters label{cursor:pointer}.filters input{display:none}.filters input:checked+.chip{background:var(--amber);color:var(--ink)}
.filters .sort{margin-left:auto;display:inline-flex;gap:6px;align-items:center;cursor:default}
.filters .sort select{font:9.5px var(--font-pixel);text-transform:uppercase;letter-spacing:.08em;padding:6px 8px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink)}
.tabs{display:flex;gap:0;margin:22px 0 0}.tabs a{font:9.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;padding:9px 14px;border:1px solid var(--hair);border-bottom:none;text-decoration:none;background:var(--cream-md);white-space:nowrap}
.tabs a.on{background:var(--cream-hi);position:relative;top:2px}
#count{margin:14px 0 8px}
.teams{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));margin:0 0 28px}
.team{display:flex;flex-direction:column;background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift)}
.team .head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--hair);background:var(--cream-md)}
.team .head .ttl{font:700 10px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.team .head .stand{margin-left:auto;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.team .screen{height:64px;padding:10px 12px;display:flex;flex-direction:column;justify-content:flex-end;border-bottom:1px solid var(--hair)}
.team .screen .l{white-space:pre;overflow:hidden;text-overflow:ellipsis}.team .screen .l.d{color:var(--phos-dim)}
.team .body{padding:12px 14px;flex:1}.team .body p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.team .body p{margin:0;font-size:14px;color:var(--muted)}
.team .body .note-line{font-size:12.5px;margin-top:auto}
.team .foot{display:flex;padding:10px 12px;border-top:1px solid var(--line-soft)}
.team .foot .btn{flex:1;justify-content:center;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.team.example{opacity:.9}.team.example .head::after{content:'EXAMPLE';font:8px var(--font-pixel);letter-spacing:.06em;border:1px solid var(--line);padding:1px 5px;background:var(--violet-hi);color:var(--ink)}
.empty{padding:40px;text-align:center;color:var(--muted);border:2px dashed var(--line-soft)}
/* the shop: who is reading, the shelf of what they hold, and what a card is to them */
.who{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 2px;padding:10px 14px;border:1px solid var(--hair);background:var(--cream-hi);box-shadow:var(--lift-sm)}
.who .meta{flex:1;min-width:220px}
.shelf{margin:18px 0 6px;padding:14px 16px 2px;border:1px solid var(--hair);background:var(--amber-soft);box-shadow:var(--lift)}
.shelf h2.mkt-h{margin:0 0 12px;font-size:15px}
/* YOUR AGENTS — the signed-in reader's own teams, first on the page, one row and one act each */
.yours{margin:10px 0 4px;padding:0;border:1px solid var(--hair);background:var(--amber-soft);box-shadow:var(--lift)}
.yours-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--hair)}
.yours-head h2{margin:0;font-size:15px}.yours-head .sp{flex:1}
.yours-empty{margin:0;padding:12px 14px}
.yours-rows{list-style:none;margin:0;padding:0}
.yours-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;gap:10px;align-items:center;padding:10px 14px;background:var(--cream-hi);border-bottom:1px solid var(--line-soft)}
.yours-row:last-child{border-bottom:none}
.yours-row .ttl{font:700 10px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yours-row .meta{white-space:nowrap}.yours-row .stand{white-space:nowrap}
.yours-row .btn{white-space:nowrap}
@media (max-width:760px){
  .yours-row{grid-template-columns:auto minmax(0,1fr) auto auto}
  .yours-row .meta{display:none}.yours-row .stand{display:none}
}
@media (max-width:700px){
  .who{padding:9px 12px;gap:8px}.who .meta{min-width:0;font-size:12.5px}.who .btn{margin-left:auto}
  .tabs{margin-top:16px}.tabs a{flex:1;text-align:center;padding:9px 6px;font-size:8.5px}
  .finder{padding:10px 10px 8px}.toolbar .btn{display:none}
  .filters{gap:5px}.filters .chip{font-size:7.5px}.filters .sort{margin-left:auto}.filters .sort .meta{display:none}
  .teams{gap:14px}.team .screen{height:76px}.team .head .stand{max-width:60%}
  .team .foot{padding:9px 10px}
}
/* team page */
.tp-head h1{font-size:clamp(26px,3.4vw,38px)}
.tp-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start}
.tp-actions{display:flex;gap:10px;align-items:center;justify-content:flex-end;padding-top:26px}
@media (max-width:760px){.tp-head{grid-template-columns:1fr}.tp-actions{justify-content:flex-start;padding-top:0}.tp-actions .btn{flex:1;justify-content:center}.seat .row .btn{flex:1;justify-content:center}}
.tp{display:grid;gap:26px;grid-template-columns:minmax(0,1fr) 320px;align-items:start}.tp.one{grid-template-columns:minmax(0,1fr)}
@media (max-width:960px){.tp{grid-template-columns:1fr}}
.overlay{border:1px solid var(--hair);box-shadow:var(--lift);background:var(--cream-hi);display:grid;grid-template-columns:minmax(0,1fr) 230px;min-height:520px}
@media (max-width:760px){.overlay{grid-template-columns:minmax(0,1fr)}}
.overlay .bar{grid-column:1/-1;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--hair);background:var(--cream-md);flex-wrap:wrap}
.overlay .bar .name{font:700 11px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase}
.overlay .bar .sp{flex:1}
.strip{grid-column:1/-1;font-size:12.5px;color:var(--muted);padding:6px 12px;border-bottom:1px solid var(--line-soft);display:flex;gap:6px;flex-wrap:wrap}
.strip .sep{color:var(--dim)}.strip .state{color:var(--ink)}
.term{background:var(--phos-bg);position:relative;display:flex;flex-direction:column;min-height:420px;min-width:0}
.term::before{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,rgba(255,255,255,.03) 0,rgba(255,255,255,.03) 1px,transparent 1px,transparent 3px)}
.term .out{flex:1;min-width:0;padding:12px 14px;font:15px/1.28 var(--font-screen);color:var(--phos);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:440px}
.term .out .d{color:var(--phos-dim)}.term .out .g{color:var(--phos-glow)}.term .out .h{color:var(--hp)}.term .out .r{color:#ff8a80}
.term .gate{position:absolute;inset:0;display:grid;place-items:center;background:rgba(20,17,10,.86);padding:20px;text-align:center}
.term .gate .card{max-width:380px}
.term .gate .card p{font-size:14px;color:var(--muted)}.term .gate .acts{justify-content:center;align-items:center;gap:12px}.term .gate .acts .ask{font-size:13px;color:var(--muted)}.term .gate #seat-head:empty,.term .gate #gate-p:empty,.term .gate #gate-actions:not(:has(:not([hidden]))){display:none}.term .gate #seat-head{font-size:14px;color:var(--muted)}
.tp-head.one{display:block}.tp-foot{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:12px 0 0}.tp-foot .mono{font:13px var(--font-mono);color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis}.tp-foot a{color:var(--ink)}
.term .in{display:flex;gap:8px;padding:8px;border-top:1px solid var(--hair);background:var(--cream-hi);position:relative;z-index:1}
.term .in input{flex:1;font:14px var(--font-mono);padding:8px 10px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink);outline:none}
.term .in input:focus{background:var(--amber-soft)}
.rail{border-left:1px solid var(--hair);background:var(--cream-hi);display:flex;flex-direction:column;min-height:0}
@media (max-width:760px){.rail{border-left:none;border-top:1px solid var(--hair)}}
.rail .rh{font:700 9px var(--font-pixel);letter-spacing:.1em;text-transform:uppercase;padding:8px 12px;border-bottom:1px solid var(--line-soft);color:var(--ink-soft);display:flex;justify-content:space-between}
.rail ol{list-style:none;margin:0;padding:6px 0;overflow:auto;flex:1}
.rail li{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:6px 12px;font-size:12.5px;align-items:start;cursor:pointer}
.rail li:hover{background:var(--amber-soft)}.rail li.focus{background:var(--amber);color:var(--ink)}
.rail li .n{font:9px var(--font-pixel);color:var(--ink-soft);padding-top:3px}.rail li.focus .n{color:var(--ink)}
.rail li .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail li.live .t{font-weight:700}.rail li .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--hp);margin-right:6px;animation:blink 1.1s steps(2) infinite}
.rail li.ended .dot{background:var(--dim);animation:none}
.side .card{margin-bottom:18px}
.side dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px}
.side dt{color:var(--muted)}.side dd{margin:0}
.addr{display:flex;gap:8px;align-items:center;background:var(--cream-md);border:1px solid var(--hair);padding:8px 10px;font:13px var(--font-mono);overflow:hidden}
.addr span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:18px 0}
.dl .card small{display:block;color:var(--muted);margin-top:6px;font-size:12.5px}
.hero{padding:22px 0 20px;border-bottom:1px solid var(--hair)}
/* the homepage: the page in one column, its catalog on the right rail. The
   sections keep their own .wrap markup; inside the column it is just a box. */
.home{display:grid;grid-template-columns:minmax(0,1fr) 188px;gap:0 40px;align-items:start}
.home .home-body{min-width:0}
.home .home-body .wrap{max-width:none;padding:0}
.toc{position:sticky;top:18px;order:2;padding-top:64px}
.toc .kicker{margin-bottom:8px}
.toc ol{list-style:none;margin:0;padding:0;border-left:1px solid var(--hair)}
.toc a{display:block;padding:6px 12px;font:700 9.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);text-decoration:none}
.toc a:hover{background:var(--amber-soft);color:var(--ink)}
.toc li.sub a{font:500 12.5px var(--font-body);letter-spacing:0;text-transform:none;color:var(--muted);padding:3px 12px 3px 22px}
/* the rail's two destinations, pinned above the section list. Declared before
   the breakpoint below on purpose: it hides them at equal specificity, so
   source order is what decides. */
.toc .jump{display:grid;gap:6px;margin:0 0 12px}
.toc .jump a{border:1px solid var(--hair);box-shadow:var(--lift-sm);background:var(--cream-hi);text-align:center}
.toc .jump a.primary{background:var(--amber)}
@media (max-width:1000px){
  .home{grid-template-columns:1fr}
  .toc{position:static;order:-1;padding:14px 0 0}
  .toc .kicker{display:none}
  .toc ol{display:flex;flex-wrap:wrap;gap:6px;border-left:none}
  .toc li.sub{display:none}
  .toc a{border:1px solid var(--line);background:var(--cream-hi);box-shadow:var(--lift-sm)}
  /* the rail folds above the brand here, and the sticky header is already
     carrying both destinations two rows up — one copy is enough. */
  .toc .jump{display:none}
}
.hero .wrap{display:grid;gap:34px;grid-template-columns:minmax(0,6fr) minmax(0,7fr);align-items:center}
@media (max-width:900px){.hero .wrap{grid-template-columns:1fr}}
.hero h1{margin-bottom:12px;font-size:clamp(28px,3.3vw,40px)}
/* the lockup is the header's mark writ large — a brand beat, not a billboard.
   site-brand.ts sizes it for a full-width band; in the hero it shares the
   column with the headline, so it is capped here. */
.hero .brand{padding:0 0 14px}
.hero .brand .stack{width:min(100%,400px)}
.hero .lede{margin-bottom:16px;font-size:clamp(16px,1.4vw,18px);max-width:46ch}
.hero .row#download{gap:8px}
.hero .row#download .btn.lg{padding:11px 13px}
.hero .tagline{margin-bottom:12px;font-size:9px;letter-spacing:.1em;white-space:nowrap}
/* THE DOCK — the strip under the hero. Three cells, the app's own chrome: a
   lamp, what it is, and the one number that says whether it is worth a click.
   It is the second thing on the page so the marketplace is never a scroll. */
.dock{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--hair);box-shadow:var(--lift);background:var(--cream-hi);margin:0 0 4px}
.dock a{display:flex;gap:12px;align-items:center;padding:14px 16px;text-decoration:none;border-right:1px solid var(--hair)}
.dock a:last-child{border-right:none}
.dock a:hover{background:var(--amber-soft)}
.dock a:last-child{background:var(--amber)}
.dock a:last-child:hover{background:var(--amber-soft)}
.dock .t{font:700 9.5px var(--font-pixel);letter-spacing:.1em;text-transform:uppercase;display:block;margin-bottom:3px}
.dock .d{font-size:13px;color:var(--muted);display:block;line-height:1.35}
.dock .ico{font:16px var(--font-screen);background:var(--phos-bg);color:var(--phos);border:1px solid var(--hair);width:34px;height:34px;display:grid;place-items:center;flex:0 0 auto}
@media (max-width:760px){.dock{grid-template-columns:1fr}.dock a{border-right:none;border-bottom:1px solid var(--hair)}.dock a:last-child{border-bottom:none}}
.mkt-h{display:flex;align-items:center;gap:10px;font-size:17px;margin:22px 0 4px;flex-wrap:wrap}
.mkt-h .sp{flex:1}
/* THE RENT STRIP — the marketplace's priced instances on the first screen,
   right under the hero: the price and a BUY on each, at most three, the rest
   one link away. The dock follows it as one compact row. */
.rent-strip{margin:18px 0 10px}
.rent-strip .mkt-h{margin:0 0 10px}
.rent-cards{display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr))}
.rent{display:flex;flex-direction:column;gap:8px;background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift);padding:12px 14px;min-width:0}
.rent.off{background:var(--cream-md)}
.rent .head{display:flex;align-items:center;gap:8px;min-width:0}
.rent .head .ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}
.rent p{margin:0;font-size:14px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rent .foot{display:flex;gap:8px;margin-top:auto;padding-top:4px}
.rent .foot .btn{flex:1;justify-content:center;white-space:nowrap;padding-inline:8px}.rent .foot .btn.primary{flex:1.5}
@media (max-width:900px){.rent-cards{grid-template-columns:1fr 1fr}}
@media (max-width:640px){.rent-cards{grid-template-columns:1fr}.rent .foot{flex-direction:column}}
.dock.compact a{padding:9px 14px}
.dock.compact .d{display:none}
.dock.compact .ico{width:26px;height:26px;font-size:13px}
.dock.compact .t{margin:0}
/* a list inside a folded FAQ block — the team page's "how it works", the market's notes */
.faq ol.how,.faq ul.how{margin:0;padding:0 16px 14px 34px;color:var(--muted);font-size:14px}
.faq .how li{margin:6px 0}.faq .how b{color:var(--ink)}
.tagline{display:inline-block;background:var(--amber);color:var(--ink);font:700 9.5px var(--font-pixel);letter-spacing:.14em;padding:4px 10px;border:1px solid var(--hair);transform:rotate(-1deg);margin-bottom:18px}
.faq details{border:1px solid var(--hair);background:var(--cream-hi);margin:8px 0;box-shadow:var(--lift-sm)}
.faq summary{cursor:pointer;padding:10px 14px;font-weight:600}.faq details>p{padding:0 16px 14px;margin:0;color:var(--muted)}
.commits{list-style:none;padding:0;margin:14px 0;border:1px solid var(--hair);background:var(--cream-hi);box-shadow:var(--lift)}
.commits li{padding:9px 14px;border-bottom:1px solid var(--line-soft);font-size:14px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.commits li:last-child{border-bottom:none}
.commits time{font:600 12px var(--font-mono);color:var(--ink-soft)}
table.cmp{border-collapse:collapse;width:100%;font-size:14px;background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift);margin:14px 0}
table.cmp caption{caption-side:bottom;font-size:12.5px;color:var(--muted);padding:8px 0;text-align:left}
table.cmp th,table.cmp td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--line-soft);vertical-align:top}
table.cmp thead th{font:700 9px var(--font-pixel);letter-spacing:.1em;text-transform:uppercase;background:var(--cream-md);color:var(--ink-soft)}
table.cmp tbody th{font-weight:600;color:var(--ink)}table.cmp td:last-child{background:var(--amber-soft)}
ol.steps{list-style:none;padding:0;margin:14px 0;display:grid;gap:26px}
ol.steps .step{display:grid;grid-template-columns:44px 1fr;gap:14px;align-items:start}
ol.steps .step-no{font:700 16px var(--font-pixel);background:var(--amber);border:1px solid var(--hair);box-shadow:var(--lift-sm);width:40px;height:40px;display:grid;place-items:center}
ol.howto{padding-left:0;list-style:none;counter-reset:h;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin:14px 0}
ol.howto>li{counter-increment:h;background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift-sm);padding:14px 16px}
ol.howto>li h3::before{content:counter(h) ' · ';color:var(--amber-deep);font-family:var(--font-pixel);font-size:11px}
ol.howto>li>p{margin:0;color:var(--muted);font-size:14px}
ol.howto.two{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}ol.howto.two>li h3{font-size:18px}ol.howto.two>li>p{font-size:15px;color:var(--ink)}ol.howto.two ul.pts{margin-top:10px;font-size:13.5px}
.rec-chip{background:var(--hp);color:var(--on-seal)}
ul.one-liners{list-style:none;padding:0;margin:14px 0;border:1px solid var(--hair);background:var(--cream-hi);box-shadow:var(--lift)}
ul.one-liners li{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:6px 18px;padding:10px 14px;border-bottom:1px solid var(--line-soft);font-size:14.5px}
ul.one-liners li:last-child{border-bottom:none}ul.one-liners a{text-decoration:none}ul.one-liners span{color:var(--muted)}
@media (max-width:700px){ul.one-liners li{grid-template-columns:1fr}}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--cream-hi);border:1px solid var(--hair);box-shadow:var(--lift);padding:10px 14px;font-size:14px;display:none;z-index:99;max-width:90vw}
.toast.on{display:block}
/* ── THE INK LAYER (2026-10-31): the app's ink theme on the site — warm paper with grain,
   serif for what is named, small spaced mono for what is labelled, a subdued amber for what is
   picked, the seal for marks, red only for something waiting. Cards lift; nothing is bevelled. */
body{background-color:var(--cream);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .47 0 0 0 0 .39 0 0 0 0 .27 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23g)'/%3E%3C/svg%3E"),radial-gradient(1200px 520px at 18% -8%,var(--wash),transparent 70%),radial-gradient(900px 600px at 105% 30%,var(--wash),transparent 70%);background-attachment:fixed}
::selection{background:var(--amber-soft)}
h1,h2,h3,.ttl,.serif{font-family:var(--font-serif);font-weight:600;letter-spacing:0}
h1{letter-spacing:-.01em;line-height:1.08}h2{font-weight:600}
.lede{font-family:var(--font-serif);color:var(--ink-soft)}
.hdr{background:color-mix(in srgb,var(--cream) 88%,transparent);backdrop-filter:saturate(1.1) blur(8px);-webkit-backdrop-filter:saturate(1.1) blur(8px)}
.chip{font:500 10px var(--font-mono);letter-spacing:.08em;border-radius:4px;padding:2px 7px;background:var(--cream-md)}
.chip.amber{background:var(--amber-soft);color:var(--amber-deep);border-color:transparent}
.chip.violet{background:var(--violet-hi);color:var(--ink);border-color:transparent}
.chip.rose{background:var(--rose)}
.btn{font:600 11px var(--font-mono);letter-spacing:.08em;border:1.5px solid var(--line);border-radius:7px;background:var(--cream-hi);color:var(--ink);transition:background .15s,border-color .15s}
.btn:hover{background:var(--amber-soft);border-color:var(--ink)}
.btn.primary{background:var(--amber);border-color:transparent;color:#1d1a16}.btn.primary:hover{border-color:var(--ink)}
.btn.sm{font-size:10px;border-radius:6px;padding:4px 9px}.btn.lg{font-size:12px;padding:11px 16px;border-radius:9px}
.btn.danger{background:var(--ink);border-color:var(--ink);color:var(--cream)}
.btn:focus-visible,.star:focus-visible,a:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
.led{border:none;box-shadow:none;width:9px;height:9px}.led.busy{background:var(--amber);box-shadow:none}
.kicker{font:600 10.5px var(--font-mono);letter-spacing:.16em;color:var(--ink-soft)}
.kicker .no{background:var(--seal-fill);color:var(--on-seal);border:none;border-radius:4px;padding:2px 7px}
.tagline{background:none;border:none;color:var(--amber-deep);font:600 10.5px var(--font-mono);letter-spacing:.18em;padding:0;transform:none}
.tagline::before{content:'';display:inline-block;width:22px;height:1px;background:currentColor;vertical-align:middle;margin-right:10px}
.card,.team,.rent,.stat,.who,.shelf,.yours,ul.doors,.commits,table.cmp,ul.one-liners,.faq details,ol.howto>li,.overlay,.dock,.seat.strip,.totp-panel,.toast{border-radius:12px;overflow:hidden}
.card.soft,.note{border-radius:10px}
.note{transform:rotate(-.4deg);box-shadow:var(--lift-sm);border:1px solid rgba(120,95,40,.18)}
.team .head,.overlay .bar{background:transparent}
.team .head .ttl,.yours-row .ttl,.overlay .bar .name{font:600 16px var(--font-serif);letter-spacing:0;text-transform:none}
.dock .t,.toc a,.rail .rh,.tabs a,.filters .sort select,footer nav a,table.cmp thead th{font-family:var(--font-mono);font-weight:600}
.dock .ico,.crt,.cmd{border-radius:8px}
.dock .ico{background:var(--cream-md);color:var(--ink);border:1px solid var(--hair)}
.dock a:last-child{background:var(--amber-soft)}
.crt,.team .screen{background:var(--cream-md);color:var(--ink-soft);font:12.5px/1.55 var(--font-mono);box-shadow:none;border:none;border-bottom:1px solid var(--hair)}
.crt::before,.term::before{display:none}
.team .screen{border-radius:0}.team .screen .l.d{color:var(--muted)}
.cmd{background:var(--cream-md);color:var(--ink);font:13.5px/1.6 var(--font-mono);border:1px solid var(--hair);border-left:3px solid var(--seal);box-shadow:none}
.cmd .c{color:var(--muted)}
figure.shot{border-radius:14px;background:var(--cream-hi)}
figure.shot figcaption{font-size:13.5px;line-height:1.5}
figure.shot .rec{font:600 9.5px var(--font-mono);letter-spacing:.1em;background:var(--seal-fill);color:var(--on-seal);border:none;border-radius:4px}
.stat b{font:600 34px/1 var(--font-serif);color:var(--amber-deep);letter-spacing:-.01em}
ol.steps .step-no{font:600 18px var(--font-serif);background:var(--seal-fill);color:var(--on-seal);border:none;border-radius:50%;box-shadow:none}
ol.howto>li h3::before{font-family:var(--font-mono);color:var(--seal)}
.tabs a{border-radius:8px 8px 0 0}
.finder input[type=search],.toolbar input[type=search],.term .in input,.seat input,.acct-row input,.acct-code{border-radius:8px;border:1px solid var(--line);box-shadow:none}
:is(.finder,.toolbar) input[type=search]:focus,.term .in input:focus,.seat input:focus,.acct-row input:focus,.acct-code:focus{background:var(--cream-hi);border-color:var(--seal);box-shadow:0 0 0 3px var(--amber-soft)}
.rail li.focus{background:var(--amber-soft);color:var(--ink)}.rail li.focus .n{color:var(--amber-deep)}
.star{border-radius:7px;font-family:var(--font-mono)}.star.on{background:var(--amber-soft);color:var(--amber-deep)}
.price{border-radius:5px;border-color:var(--line-soft)}
.toc ol{border-left:1px solid var(--hair)}.toc a:hover{background:var(--wash)}
.toc .jump a{border-radius:7px}
.empty{border-radius:12px}
section{border-bottom:none;position:relative}
section+section::before,.hero+.wrap::before{content:'';position:absolute;top:0;left:0;right:0;height:10px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 10' preserveAspectRatio='none'%3E%3Cpath d='M2 6 C 220 3, 420 8, 640 5 S 1020 3, 1198 6' fill='none' stroke='%231d1a16' stroke-opacity='.22' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E") center/100% 100% no-repeat}
.hero{border-bottom:none}
@media (prefers-color-scheme:dark){section+section::before{filter:invert(1)}}
footer nav a{border-radius:5px}
.wrap.market{padding-top:30px;padding-bottom:44px}
.term{background:var(--cream-hi)}.term .out{font:13px/1.5 var(--font-mono);color:var(--ink)}
.term .out .d{color:var(--muted)}.term .out .g{color:var(--amber-deep)}.term .out .h{color:var(--hp)}.term .out .r{color:var(--rose)}
.term .gate{background:color-mix(in srgb,var(--cream) 82%,transparent);backdrop-filter:blur(2px)}
.l3card{background:var(--cream-hi)!important;color:var(--ink)!important;box-shadow:var(--lift)!important;border:1px solid var(--hair)!important}
.motion{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin:12px 0 30px}
.motion figure.shot video{aspect-ratio:auto;height:auto}
.motion figure.shot figcaption{align-items:flex-start}.motion figure.shot figcaption b{font-size:15px;color:var(--ink)}
dialog.acct{border-radius:14px}
`
/** The sheet's and /me's own dress, appended to the site's one stylesheet. */
export const ACCOUNT_STYLE = `
dialog.acct{max-width:420px;width:calc(100vw - 32px);border:1px solid var(--hair);box-shadow:var(--lift);background:var(--cream-hi);color:var(--ink);padding:20px}
dialog.acct::backdrop{background:rgba(20,17,10,.55)}
.acct-tabs{display:flex;gap:6px;margin-bottom:12px}
.acct-row{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;margin:10px 0}
.acct-row>span{grid-column:1/-1;font:9px var(--font-pixel);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
.acct-row input{font:14px var(--font-mono);padding:9px 11px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink);outline:none;width:100%}
.acct-row input:focus{background:var(--amber-soft)}
.acct-row .chip{justify-self:end}
.acct-row .chip.ok{background:var(--hp);color:var(--on-seal)}.acct-row .chip.no{background:var(--rose);color:var(--on-seal)}
.me-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.avatar{width:56px;height:56px;display:grid;place-items:center;border:1px solid var(--hair);box-shadow:var(--lift-sm);background:var(--amber);color:var(--ink);font:700 18px var(--font-pixel);object-fit:cover}
ul.me-list li{grid-template-columns:auto 1fr auto}
.seat{margin:20px 0 4px}
/* the seat strip: one sentence and the one act — sign in, open, or buy / ask */
.seat.strip{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0 12px;padding:10px 14px;border:1px solid var(--hair);background:var(--cream-hi);box-shadow:var(--lift-sm)}
.seat.strip .meta{flex:1;min-width:200px}.seat.strip .sp{display:none}
@media (max-width:700px){.seat.strip .meta{flex-basis:100%}.seat.strip .btn{flex:1;justify-content:center}}
.seat h2{margin:0 0 6px;font:11px var(--font-pixel);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
.seat .row{gap:10px;flex-wrap:wrap;align-items:center}
.seat input{font:14px var(--font-mono);padding:8px 10px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink);min-width:220px;outline:none}
.seat input:focus{background:var(--amber-soft)}
.seat ul.me-list{margin-top:12px}
li.desktop .reach-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
li.desktop .chip[data-badge]{min-width:78px;justify-content:center}
li.desktop .chip.ok{background:var(--hp);color:var(--on-seal)}
/* phase 4 — the ladder in the sheet, and the Security rows */
.acct-passkey{width:100%;margin:0 0 8px}
.acct-ladder{margin-top:8px}
.acct-rung{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-soft)}
.acct-rung .sp{flex:1;font-size:14px}
.acct-code{font:16px var(--font-mono);letter-spacing:.12em;padding:9px 11px;border:1px solid var(--hair);background:var(--cream-hi);color:var(--ink);outline:none;flex:1;min-width:0}
.acct-code:focus{background:var(--amber-soft)}
.acct-asked{font:700 12px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;margin:2px 0 6px}
/* W4: the two digits the other device has to be looking at. Large because it
   is read off this screen and typed on another one, across a room. */
.acct-match{font:700 44px var(--font-mono);letter-spacing:.14em;margin:4px 0 8px;color:var(--ink)}
/* W5: the same, for a join code read onto a machine that has nothing typed
   on it but this. Selectable, because the two devices may be one desk apart. */
.acct-join-code{font:700 28px var(--font-mono);letter-spacing:.14em;margin:6px 0;user-select:all;color:var(--ink)}
/* W5: the number the approver types, inline in the row rather than below it —
   the question and the field are one sentence. */
.acct-match-field{flex:0 0 4.5em;margin-left:8px;text-align:center;letter-spacing:.2em}
ul.me-list li .btn.sm+.btn.sm{margin-left:6px}
/* M5: the row's own line — why it is waiting, or what the Mac answered. */
.reach-note{flex-basis:100%;margin:6px 0 0}
/*
 * M6 · THE REQUESTS QUEUE AT PHONE WIDTH.
 *
 * The phone is where a join is most often answered — somebody is holding the
 * Mac that is asking — so the row stops being a line with controls at its end
 * and becomes a card: the sentence, then the number, then the answers. THE
 * NUMBER FIELD IS THE PRIMARY CONTROL here and it is sized like one; a 4.5em
 * box at the end of a wrapped row is the hardest thing on the screen to hit
 * and the only thing that must be hit first.
 */
.req-actions{display:flex;gap:6px;align-items:center}
@media (max-width:700px){
  /* ONE COLUMN, in reading order: what is being asked, the number, the answers.
     A me-list row is a THREE-COLUMN GRID, so this collapses the template
     rather than fighting it with flex rules the element never sees — five
     children in three columns auto-placed the number beside a button, which
     at phone width is the wrong thing under the thumb. */
  ul.me-list li.req{grid-template-columns:1fr;gap:8px}
  ul.me-list li.req .acct-match-field{display:block;width:100%;box-sizing:border-box;margin:8px 0 0;font-size:30px;padding:12px;letter-spacing:.3em}
  ul.me-list li.req .req-actions{width:100%}
  ul.me-list li.req .req-actions .btn{flex:1 1 0;justify-content:center}
  ul.me-list li.req .btn.sm+.btn.sm{margin-left:0}
}
/* the authenticator's scan-then-verify panel on /me */
.totp-panel{border:1px solid var(--hair);background:var(--cream-hi);padding:14px;margin:10px 0;max-width:420px}
.totp-panel svg{display:block;margin:8px 0;border:1px solid var(--hair);background:#fff}
.totp-secret{font:13px var(--font-mono);letter-spacing:.08em;background:var(--cream-md);padding:2px 6px;user-select:all}
.totp-link{display:block;font:11px var(--font-mono);word-break:break-all;color:var(--muted);margin:6px 0 10px}
.totp-said:empty{display:none}
.totp-said{color:var(--rose)}
`
