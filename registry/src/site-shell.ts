import type { ServerResponse } from 'node:http'
import { ASSET_VERSION } from './assets-bundle'

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
 * Fonts are the app's four (Silkscreen, VT323, JetBrains Mono, Inter), from
 * Google Fonts as the app itself loads them; recorded frames come from this
 * repository on GitHub so the bundle stays small enough for its ConfigMap.
 */

export const SITE_FONTS_CSS = 'https://fonts.googleapis.com'
export const SITE_FONTS_FILES = 'https://fonts.gstatic.com'
/** Where the homepage's recorded frames live: the repository, on the branch the registry is built from. */
declare const __SITE_REF__: string | undefined
/** The git ref the bundle was built from (esbuild --define), else the dev branch. */
const SITE_REF = typeof __SITE_REF__ === 'string' && /^[0-9a-f]{7,40}$/.test(__SITE_REF__) ? __SITE_REF__ : 'dev'
export const SITE_FRAMES = `https://raw.githubusercontent.com/cookrew/cookrew-app/${SITE_REF}/registry/assets/site/`
export const GITHUB_REPO = 'https://github.com/cookrew/cookrew-app'

export type PageKind = 'document' | 'app'

const CSP: Record<PageKind, string> = {
  document: `default-src 'none'; style-src 'unsafe-inline' ${SITE_FONTS_CSS}; font-src ${SITE_FONTS_FILES}; img-src ${SITE_FRAMES} data:; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  app: `default-src 'none'; style-src 'self' 'unsafe-inline' ${SITE_FONTS_CSS}; font-src ${SITE_FONTS_FILES}; img-src ${SITE_FRAMES} data:; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
}

export interface Page {
  status: number
  headers: Record<string, string>
  body: string
}

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
  /** Which header button is lit. */
  active?: 'home' | 'market' | 'download'
  /** Scripts from /assets, app pages only. */
  scripts?: string[]
  /** Stylesheets from /assets, app pages only. */
  styles?: string[]
  /**
   * Cache lifetime in seconds; 0 for pages that must not be cached. A page
   * rendered for a signed-in reader is never shared: 0 means private/no-store.
   */
  cache?: number
  status?: number
}

export function page(options: ShellOptions, main: string): Page {
  return {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP[options.kind],
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

/** A generated document, with the headers that make it inert. */
export function respondPage(response: ServerResponse, rendered: Page): void {
  const payload = Buffer.from(rendered.body, 'utf8')
  response.writeHead(rendered.status, {
    ...rendered.headers,
    'content-length': String(payload.byteLength)
  })
  response.end(payload)
}

const LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" fill="#14110a" stroke="currentColor" stroke-width="2"/><rect x="5" y="6" width="6" height="2" fill="#e9b949"/><rect x="5" y="10" width="10" height="2" fill="#e9b949"/><rect x="5" y="14" width="4" height="2" fill="#e9b949"/><rect x="11" y="14" width="2" height="2" fill="#ffd600"><animate attributeName="opacity" values="1;0;1" dur="1.1s" repeatCount="indefinite"/></rect></svg>`

const FONTS = `<link rel="preconnect" href="${SITE_FONTS_CSS}"><link rel="preconnect" href="${SITE_FONTS_FILES}" crossorigin><link href="${SITE_FONTS_CSS}/css2?family=VT323&family=Silkscreen:wght@400;700&family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`

function shell(options: ShellOptions, main: string): string {
  const nav = [
    ['/market', 'Marketplace', 'market'],
    ['/#download', 'Download', 'download'],
    [GITHUB_REPO, 'GitHub', 'github']
  ]
    .map(
      ([href, label, key]) =>
        `<a class="btn sm${options.active === key ? ' primary' : ''}" href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`
    )
    .join('')
  const account =
    options.kind === 'app'
      ? `<button class="btn sm" id="signin" data-signin>🔑 Sign in</button>`
      : `<a class="btn sm" href="/market#account">🔑 Sign in</a>`
  const scripts = (options.kind === 'app' ? options.scripts ?? [] : [])
    .map((s) => `<script src="/assets/${esc(s)}?v=${ASSET_VERSION}" defer></script>`)
    .join('')
  const styles = (options.kind === 'app' ? options.styles ?? [] : [])
    .map((s) => `<link rel="stylesheet" href="/assets/${esc(s)}?v=${ASSET_VERSION}">`)
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(options.title)}</title>${FONTS}${styles}<style>${SITE_STYLE}</style>${scripts}</head>
<body>
<header class="hdr"><div class="wrap">
<a class="mark" href="/">${LOGO}<span>COOK<b>REW</b></span></a>
<span class="chip">an open-source spatial workspace for AI agents</span>
<nav class="top">${nav}${account}</nav>
</div></header>
${main}
<footer><div class="wrap"><div class="row">
<span>cookrew.dev · <a href="/v1/doors">the directory, as data</a> · <a href="${GITHUB_REPO}/releases">releases</a> · <a href="${GITHUB_REPO}">source</a></span>
<span>Generated from the registry's live directory.</span>
</div></div></footer>
<div class="toast" id="toast" hidden></div>
</body></html>`
}

/** One stylesheet for every document; a second would drift from the first. */
export const SITE_STYLE = `
:root{--cream:#faf8f4;--cream-hi:#fffef5;--cream-md:#f5f0e8;--cream-lo:#ece6da;--ink:#2d2a20;--ink-soft:#5c4a1f;
--muted:#78716c;--dim:#a8a29e;--line:#2d2a20;--line-soft:#d9d3c5;--amber:#ffd600;--amber-soft:#fff3ad;--amber-deep:#d97706;
--phos:#e9b949;--phos-dim:#8a6d1c;--phos-glow:#ffd77a;--phos-bg:#14110a;--hp:#6bbe58;--rose:#dc2626;--violet:#9b8acb;--violet-hi:#c3b6e6;
--note-bg:#fff3ad;--font-pixel:'Silkscreen','Courier New',monospace;--font-screen:'VT323','Courier New',monospace;
--font-mono:'JetBrains Mono','SF Mono',Menlo,monospace;--font-body:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}
@media (prefers-color-scheme:dark){:root{--cream:#1b1912;--cream-hi:#23201a;--cream-md:#2a2721;--cream-lo:#33302a;--ink:#f0ecdf;
--ink-soft:#e2d3a8;--muted:#a49b86;--dim:#6e685c;--line:#f0ecdf;--line-soft:#3a362d;--amber-soft:#4a3d0b;--note-bg:#4a3d0b}}
*{box-sizing:border-box}html{scroll-behavior:smooth}[hidden]{display:none!important}
body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.6 var(--font-body);-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px}
/* header — the app's own chrome: cream-hi, 2px ink rule */
.hdr{position:sticky;top:0;z-index:50;background:var(--cream-hi);border-bottom:2px solid var(--line)}
.hdr .wrap{display:flex;align-items:center;gap:18px;height:56px}
.mark{display:flex;align-items:center;gap:9px;text-decoration:none;font:700 15px var(--font-pixel);letter-spacing:.12em}
.mark svg{width:24px;height:24px}
.mark b{color:var(--amber-deep)}
nav.top{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.chip{font:8.5px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);background:var(--cream-md);border:1.5px solid var(--line);padding:2px 6px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.chip.amber{background:var(--amber);color:#2d2a20}.chip.violet{background:var(--violet);color:#fffef5}.chip.rose{background:var(--rose);color:#fffef5}
.chip.busy{background:var(--amber-soft);animation:blink 1.1s steps(2) infinite}
.btn{font:9.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;color:#2d2a20;background:var(--cream-hi);border:2px solid var(--line);box-shadow:2px 2px 0 var(--line);padding:7px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;text-decoration:none;user-select:none}
@media (prefers-color-scheme:dark){.btn{color:var(--ink)}.btn.primary{color:#2d2a20}}
.btn:hover{background:var(--amber-soft)}.btn:active{transform:translate(2px,2px);box-shadow:none}
.btn.primary{background:var(--amber)}.btn.lg{font-size:11px;padding:11px 16px;box-shadow:3px 3px 0 var(--line)}
.btn.sm{padding:3px 8px;font-size:8.5px;box-shadow:none}.btn[disabled]{opacity:.35;pointer-events:none}
.btn.danger{background:var(--rose);color:#fffef5}
.led{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--line);background:var(--hp);box-shadow:0 0 6px rgba(107,190,88,.8);flex:0 0 auto;display:inline-block}
.led.off{background:var(--dim);box-shadow:none}.led.busy{background:var(--amber);box-shadow:0 0 8px rgba(255,214,0,.9);animation:blink .9s steps(2) infinite}
@keyframes blink{50%{opacity:.35}}
/* type */
h1{font-size:clamp(30px,4.6vw,52px);line-height:1.1;letter-spacing:-.02em;margin:0 0 18px}
h2{font:700 clamp(20px,2.6vw,30px)/1.2 var(--font-body);letter-spacing:-.01em;margin:0 0 10px}
h3{font-size:16px;margin:0 0 6px}
.kicker{font:700 9.5px var(--font-pixel);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin:0 0 10px;display:flex;gap:10px;align-items:center}
.kicker .no{background:var(--amber);color:#2d2a20;padding:1px 6px;border:1.5px solid var(--line)}
.lede{font-size:clamp(17px,1.6vw,20px);color:var(--muted);max-width:62ch;margin:0 0 22px}
p{max-width:70ch}.muted{color:var(--muted)}.dim{color:var(--dim)}
code,.mono{font-family:var(--font-mono);font-size:.88em}
.cmd{display:block;background:var(--phos-bg);color:var(--phos);font:15px/1.45 var(--font-screen);padding:14px 16px;border:2px solid var(--line);box-shadow:4px 4px 0 var(--line);overflow-x:auto;white-space:pre;margin:14px 0}
.cmd .c{color:var(--phos-dim)}
/* cards — square corners, hard bevel */
.card{background:var(--cream-hi);border:2px solid var(--line);box-shadow:4px 4px 0 var(--line);padding:18px 20px}
.card.soft{box-shadow:2px 2px 0 var(--line)}
.note{background:var(--note-bg);border:2px solid var(--line);box-shadow:3px 3px 0 var(--line);padding:12px 14px;font-size:14px;transform:rotate(-.6deg)}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid .card p{color:var(--muted);font-size:14.5px;margin:0}
/* CRT screen (phosphor) */
.crt{background:var(--phos-bg);color:var(--phos);font:15px/1.25 var(--font-screen);position:relative;border:2px solid var(--line);box-shadow:4px 4px 0 var(--line);overflow:hidden}
.crt::before{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,rgba(255,255,255,.03) 0,rgba(255,255,255,.03) 1px,transparent 1px,transparent 3px)}
/* recorded frame */
figure.shot{margin:0;border:2px solid var(--line);box-shadow:6px 6px 0 var(--line);background:var(--phos-bg);overflow:hidden}
figure.shot img{display:block;width:100%;height:auto}
figure.shot figcaption{font-size:13px;color:var(--muted);padding:9px 12px;background:var(--cream-hi);border-top:2px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
figure.shot .rec{font:8.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;background:var(--hp);color:#14110a;border:1.5px solid var(--line);padding:2px 6px}
figure.shot.missing{min-height:220px;display:grid;place-items:center;color:var(--phos-dim);font:18px var(--font-screen)}
/* sections */
section{padding:56px 0;border-bottom:2px solid var(--line-soft)}
.feature{display:grid;gap:34px;grid-template-columns:minmax(0,5fr) minmax(0,7fr);align-items:center}
.feature.flip>.text{order:2}
@media (max-width:860px){.feature{grid-template-columns:1fr}.feature.flip>.text{order:0}}
ul.pts{padding-left:18px;margin:10px 0;color:var(--muted);font-size:15px}ul.pts li{margin:4px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
/* directory rows */
ul.doors{list-style:none;padding:0;margin:0;border:2px solid var(--line);box-shadow:4px 4px 0 var(--line);background:var(--cream-hi)}
ul.doors li{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:14px 16px;border-bottom:2px solid var(--line-soft)}
ul.doors li:last-child{border-bottom:none}
.ttl{font-weight:700;font-size:17px;text-decoration:none}.meta{color:var(--muted);font-size:13.5px}
.price{font:600 12px var(--font-mono);border:1.5px solid var(--line);padding:2px 9px;color:var(--ink-soft)}
.star{font:600 12px var(--font-mono);border:2px solid var(--line);background:var(--cream-hi);box-shadow:2px 2px 0 var(--line);padding:4px 9px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;color:var(--ink)}
.star.on{background:var(--amber);color:#2d2a20}.star:active{transform:translate(2px,2px);box-shadow:none}
footer{padding:36px 0 60px;color:var(--muted);font-size:13.5px}
footer .row{justify-content:space-between}
.stats{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.stat{border:2px solid var(--line);background:var(--cream-hi);box-shadow:3px 3px 0 var(--line);padding:14px}
.stat b{display:block;font:700 30px/1 var(--font-pixel);letter-spacing:-.02em;margin-bottom:6px;color:var(--amber-deep)}
.stat span{font-size:13px;color:var(--muted)}
/* market */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:18px 0}
.toolbar input[type=search]{flex:1;min-width:220px;font:15px var(--font-mono);padding:9px 12px;border:2px solid var(--line);background:var(--cream-hi);color:var(--ink);box-shadow:2px 2px 0 var(--line);outline:none}
.toolbar input[type=search]:focus{background:var(--amber-soft)}
.toolbar select{font:9.5px var(--font-pixel);text-transform:uppercase;letter-spacing:.08em;padding:8px;border:2px solid var(--line);background:var(--cream-hi);color:var(--ink)}
.filters{display:flex;gap:6px;flex-wrap:wrap}
.filters label{cursor:pointer}.filters input{display:none}.filters input:checked+.chip{background:var(--amber);color:#2d2a20}
.tabs{display:flex;gap:0;margin:24px 0 0}.tabs a{font:9.5px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase;padding:9px 14px;border:2px solid var(--line);border-bottom:none;text-decoration:none;background:var(--cream-md)}
.tabs a.on{background:var(--cream-hi);position:relative;top:2px}
.teams{display:grid;gap:22px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));margin:0 0 30px}
.team{display:flex;flex-direction:column;background:var(--cream-hi);border:2px solid var(--line);box-shadow:4px 4px 0 var(--line)}
.team .head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:2px solid var(--line);background:var(--cream-md)}
.team .head .ttl{font:700 10px var(--font-pixel);letter-spacing:.06em;text-transform:uppercase;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.team .screen{height:96px;padding:10px 12px;display:flex;flex-direction:column;justify-content:flex-end;border-bottom:2px solid var(--line)}
.team .screen .l{white-space:pre;overflow:hidden}.team .screen .l.d{color:var(--phos-dim)}
.team .body{padding:12px 14px;display:flex;flex-direction:column;gap:8px;flex:1}
.team .body p{margin:0;font-size:14px;color:var(--muted)}
.team .foot{display:flex;gap:8px;align-items:center;padding:10px 12px;border-top:2px solid var(--line-soft);flex-wrap:wrap}
.team .foot .sp{flex:1}
.team.example{opacity:.9}.team.example .head::after{content:'EXAMPLE';font:8px var(--font-pixel);letter-spacing:.06em;border:1.5px solid var(--line);padding:1px 5px;background:var(--violet-hi);color:#2d2a20}
.empty{padding:40px;text-align:center;color:var(--muted);border:2px dashed var(--line-soft)}
/* team page */
.tp-head{}@media (max-width:760px){.tp-head{grid-template-columns:1fr!important}.tp-head>.row{align-items:flex-start!important}}
.tp{display:grid;gap:26px;grid-template-columns:minmax(0,1fr) 320px;align-items:start}
@media (max-width:960px){.tp{grid-template-columns:1fr}}
.overlay{border:2px solid var(--line);box-shadow:6px 6px 0 var(--line);background:var(--cream-hi);display:grid;grid-template-columns:minmax(0,1fr) 230px;min-height:520px}
@media (max-width:760px){.overlay{grid-template-columns:1fr}}
.overlay .bar{grid-column:1/-1;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:2px solid var(--line);background:var(--cream-md);flex-wrap:wrap}
.overlay .bar .name{font:700 11px var(--font-pixel);letter-spacing:.08em;text-transform:uppercase}
.overlay .bar .sp{flex:1}
.strip{grid-column:1/-1;font-size:12.5px;color:var(--muted);padding:6px 12px;border-bottom:2px solid var(--line-soft);display:flex;gap:6px;flex-wrap:wrap}
.strip .sep{color:var(--dim)}.strip .state{color:var(--ink)}
.term{background:var(--phos-bg);position:relative;display:flex;flex-direction:column;min-height:420px}
.term::before{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to bottom,rgba(255,255,255,.03) 0,rgba(255,255,255,.03) 1px,transparent 1px,transparent 3px)}
.term .out{flex:1;padding:12px 14px;font:15px/1.28 var(--font-screen);color:var(--phos);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:440px}
.term .out .d{color:var(--phos-dim)}.term .out .g{color:var(--phos-glow)}.term .out .h{color:var(--hp)}.term .out .r{color:#ff8a80}
.term .gate{position:absolute;inset:0;display:grid;place-items:center;background:rgba(20,17,10,.86);padding:20px;text-align:center}
.term .gate .card{max-width:380px}
.term .gate .card p{font-size:14px;color:var(--muted)}
.term .in{display:flex;gap:8px;padding:8px;border-top:2px solid var(--line);background:var(--cream-hi);position:relative;z-index:1}
.term .in input{flex:1;font:14px var(--font-mono);padding:8px 10px;border:2px solid var(--line);background:var(--cream-hi);color:var(--ink);outline:none}
.term .in input:focus{background:var(--amber-soft)}
.rail{border-left:2px solid var(--line);background:var(--cream-hi);display:flex;flex-direction:column;min-height:0}
@media (max-width:760px){.rail{border-left:none;border-top:2px solid var(--line)}}
.rail .rh{font:700 9px var(--font-pixel);letter-spacing:.1em;text-transform:uppercase;padding:8px 12px;border-bottom:2px solid var(--line-soft);color:var(--ink-soft);display:flex;justify-content:space-between}
.rail ol{list-style:none;margin:0;padding:6px 0;overflow:auto;flex:1}
.rail li{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:6px 12px;font-size:12.5px;align-items:start;cursor:pointer}
.rail li:hover{background:var(--amber-soft)}.rail li.focus{background:var(--amber);color:#2d2a20}
.rail li .n{font:9px var(--font-pixel);color:var(--ink-soft);padding-top:3px}.rail li.focus .n{color:#2d2a20}
.rail li .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail li.live .t{font-weight:700}.rail li .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--hp);margin-right:6px;animation:blink 1.1s steps(2) infinite}
.rail li.ended .dot{background:var(--dim);animation:none}
.side .card{margin-bottom:18px}
.side dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px}
.side dt{color:var(--muted)}.side dd{margin:0}
.addr{display:flex;gap:8px;align-items:center;background:var(--cream-md);border:2px solid var(--line);padding:8px 10px;font:13px var(--font-mono);overflow:hidden}
.addr span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:18px 0}
.dl .card small{display:block;color:var(--muted);margin-top:6px;font-size:12.5px}
.hero{padding:64px 0 52px;border-bottom:2px solid var(--line)}
.hero .wrap{display:grid;gap:40px;grid-template-columns:minmax(0,6fr) minmax(0,6fr);align-items:center}
@media (max-width:900px){.hero .wrap{grid-template-columns:1fr}}
.tagline{display:inline-block;background:var(--amber);color:#2d2a20;font:700 9.5px var(--font-pixel);letter-spacing:.14em;padding:4px 10px;border:2px solid var(--line);transform:rotate(-1deg);margin-bottom:18px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--cream-hi);border:2px solid var(--line);box-shadow:4px 4px 0 var(--line);padding:10px 14px;font-size:14px;display:none;z-index:99;max-width:90vw}
.toast.on{display:block}
`
