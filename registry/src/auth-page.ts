import { BRAND_MARK_SVG } from './site-brand'
import { LEGAL_PUBLISHED } from './site-legal-entity'
import { esc, SITE_STYLE } from './site-shell'

/**
 * AUTH.COOKREW.DEV — THE SIGN-IN PAGE ITSELF.
 *
 * One HTML document for both entrances (`/?request=…` from cookrew.dev, the
 * desktop app or a provider trip coming back; `/device` for a code typed from
 * a terminal). The document is a frame: the header, the hero, an empty card
 * and one script. Every screen inside the card — sign in, create, the ladder,
 * recovery codes, the handoff — is drawn by /assets/auth.js from what the
 * registry says about the request, so nothing about a person or a request is
 * ever rendered into this HTML.
 *
 * The palette is the site's own (SITE_STYLE's :root blocks, light and dark),
 * so the two origins cannot drift apart in colour; the rest of the dress is
 * this page's, kept small because the whole registry ships as one ConfigMap.
 */

export interface AuthPageOptions {
  /** This page's own origin, e.g. `https://auth.cookrew.dev`. Its host is the lock label. */
  authOrigin: string
  /** Where the product lives, e.g. `https://cookrew.dev`: the logo, the legal links. */
  productOrigin: string
  /** The bundle's content hash, so a new deploy is never a stale script. */
  assetVersion: string
  path: '/' | '/device'
}

/**
 * THE PAGE'S POLICY. One script from this origin, fetches to this origin, no
 * form ever submits anywhere (the script handles every submit), and nobody may
 * frame it. Inline style only, because the stylesheet travels in the document.
 */
export const AUTH_PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

/** The site's colour tokens, light and dark: everything in SITE_STYLE before its first rule. */
const SITE_TOKENS = (() => {
  const from = SITE_STYLE.indexOf(':root{')
  const to = SITE_STYLE.indexOf('*{box-sizing')
  return from >= 0 && to > from ? SITE_STYLE.slice(from, to).trim() : ''
})()

/** Only the tokens this page's own rules use: the values stay the site's, the bytes stay few. */
const tokensUsedBy = (rules: string): string =>
  SITE_TOKENS.replace(/--([a-z-]+):[^;}]*;?/g, (declaration, name: string) =>
    rules.includes(`var(--${name})`) ? declaration : ''
  ).replace(/;}/g, '}')

/** The paper the site is printed on (SITE_STYLE's ink layer): grain plus two warm washes. */
const PAPER =
  "background-color:var(--cream);background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .47 0 0 0 0 .39 0 0 0 0 .27 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23g)'/%3E%3C/svg%3E\"),radial-gradient(1200px 520px at 18% -8%,var(--wash),transparent 70%),radial-gradient(900px 600px at 105% 30%,var(--wash),transparent 70%);background-attachment:fixed"

const STYLE = `
*{box-sizing:border-box}[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;${PAPER};color:var(--ink);font:15px/1.55 var(--font-body);-webkit-font-smoothing:antialiased}
::selection{background:var(--amber-soft)}
a{color:inherit}
:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
.top,.foot{width:100%;max-width:1200px;margin:0 auto;padding:22px 32px;display:flex;align-items:center;justify-content:space-between;gap:14px}
.mark{display:flex;align-items:center;gap:11px;text-decoration:none;font:700 13px var(--font-mono);letter-spacing:.24em}
.mark-coo{width:25px;height:31px;display:block;overflow:visible;color:var(--ink)}
.lock{display:inline-flex;align-items:center;gap:7px;font:500 12.5px var(--font-mono);color:var(--ink-soft)}
.lock svg{width:14px;height:14px}
.layout{flex:1;width:100%;max-width:1200px;margin:0 auto;padding:20px 32px 44px;display:grid;grid-template-columns:minmax(0,1fr) 456px;gap:56px;align-items:center}
.intro{padding-left:clamp(0px,4vw,56px)}
.intro .kick{font:600 10.5px var(--font-mono);letter-spacing:.18em;text-transform:uppercase;color:var(--amber-deep);margin:0 0 22px}
.intro .kick::before{content:'';display:inline-block;width:22px;height:1px;background:currentColor;vertical-align:middle;margin-right:10px}
.intro h1{font:600 clamp(46px,5.2vw,76px)/1.02 var(--font-serif);letter-spacing:-.015em;margin:0 0 24px}
.intro h1 em{color:var(--amber-deep)}
.intro .sub{font:19px/1.55 var(--font-serif);color:var(--ink-soft);margin:0 0 34px;max-width:32ch}
.crew{display:flex;align-items:center;gap:14px;margin:0 0 28px}
.avs{display:flex}.avs .av+.av{margin-left:-10px}
.av{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;font:600 17px var(--font-serif);background:var(--amber);color:#1d1a16;border:3px solid var(--cream);box-shadow:var(--lift-sm)}
.av.b{background:var(--seal-fill);color:var(--on-seal)}.av.c{background:var(--violet-hi);color:var(--ink)}
.cap{font:500 10.5px var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.ways{display:flex;align-items:center;gap:10px}
.ways i{width:40px;height:40px;border:1px solid var(--line-soft);border-radius:11px;display:grid;place-items:center;background:var(--cream-hi);color:var(--ink-soft)}
.ways i.on{border-color:var(--seal);color:var(--ink);box-shadow:0 0 0 3px var(--amber-soft)}
.ways b{width:20px;height:1px;background:var(--line)}.ways .cap{margin-left:6px}
.ico svg{width:18px;height:18px}
.card{background:var(--cream-hi);border:1px solid var(--hair);border-radius:16px;box-shadow:var(--lift);padding:28px 32px 18px;min-width:0}
.who{display:flex;gap:13px;align-items:center;padding:0 0 18px;margin:0 0 24px;border-bottom:1px solid var(--line-soft)}
.who .ico,.rung .ico{width:42px;height:42px;border-radius:11px;background:var(--cream-md);display:grid;place-items:center;flex:0 0 auto}
.who b{display:block;font:600 17px/1.25 var(--font-serif)}
.who small{display:block;font-size:13px;line-height:1.4;color:var(--muted);overflow-wrap:anywhere}
.ucode{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;font:600 10px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.ucode span{white-space:nowrap;font:700 15px var(--font-mono);letter-spacing:.14em;color:var(--ink);background:var(--amber-soft);padding:2px 8px;border-radius:6px}
.k{font:600 10px var(--font-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
h2{font:600 30px/1.14 var(--font-serif);letter-spacing:-.01em;margin:0 0 8px}
#screen h2:focus,#screen h2:focus-visible{outline:none}
.lede{margin:0 0 22px;color:var(--ink-soft)}
.btn{display:flex;width:100%;justify-content:center;align-items:center;gap:9px;font:600 11.5px var(--font-mono);letter-spacing:.09em;text-transform:uppercase;padding:13px 16px;border:1.5px solid var(--line);border-radius:9px;background:var(--cream-hi);color:var(--ink);cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s}
.btn:hover{background:var(--amber-soft);border-color:var(--ink)}
.btn.primary{background:var(--amber);border-color:transparent;color:#1d1a16}.btn.primary:hover{border-color:var(--ink)}
.btn[disabled]{opacity:.45;pointer-events:none}.btn[aria-busy=true]{opacity:.7;cursor:progress}
.btn svg{width:15px;height:15px;flex:0 0 auto}
.btn+.btn,.pair+.btn,.btn+.pair{margin-top:10px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:10px}
.pair .btn+.btn{margin-top:0}
.or{display:flex;align-items:center;gap:12px;margin:22px 0 16px;font:500 10.5px var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.or::before,.or::after{content:'';flex:1;height:1px;background:var(--line-soft)}
.fld{display:block;margin:0 0 14px}
.fld>span{display:flex;justify-content:space-between;align-items:center;gap:8px;font:600 10.5px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);margin:0 0 6px}
.fld input{width:100%;font:16px var(--font-body);padding:12px 13px;border:1px solid var(--line);border-radius:9px;background:var(--cream-hi);color:var(--ink);outline:none}
.fld input:focus{border-color:var(--seal);box-shadow:0 0 0 3px var(--amber-soft)}
.fld small{display:block;margin-top:6px;font-size:12.5px;color:var(--muted)}
.fld input.mono{font:600 16px var(--font-mono);letter-spacing:.08em}
.fld input.code{font:600 24px var(--font-mono);letter-spacing:.28em;text-align:center;text-transform:uppercase;padding:14px 10px}
.chip{font:600 9.5px var(--font-mono);letter-spacing:.08em;padding:2px 7px;border-radius:4px;text-transform:uppercase}
.chip.ok{background:var(--hp);color:var(--on-seal)}.chip.no{background:var(--rose);color:var(--on-seal)}
.said{margin:12px 0 0;font-size:13.5px;color:var(--rose)}.said:empty{display:none}.said.calm{color:var(--muted)}
.links{display:flex;justify-content:space-between;align-items:center;gap:8px 14px;flex-wrap:wrap;margin:18px 0 0;font-size:13.5px;color:var(--muted)}
.link{background:none;border:none;padding:0;font:inherit;color:var(--ink);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px;cursor:pointer}
.link:hover{text-decoration-color:var(--ink)}
.links:has(>:only-child){justify-content:center}
.rungs{display:grid;gap:8px}
.rung{display:grid;grid-template-columns:auto 1fr auto;gap:13px;align-items:center;width:100%;text-align:left;padding:12px 14px;border:1px solid var(--line-soft);border-radius:12px;background:var(--cream-hi);color:var(--ink);font:inherit;cursor:pointer}
.rung:hover{border-color:var(--ink);background:var(--amber-soft)}
.rung b{display:block;font-weight:600;font-size:14.5px;line-height:1.3}.rung small{color:var(--muted);font-size:12.5px}
.rung .ico{width:36px;height:36px;border-radius:9px}.rung>svg{width:16px;height:16px;color:var(--muted)}
.match{font:700 68px/1 var(--font-mono);letter-spacing:.2em;padding-left:.2em;text-align:center;margin:6px 0 8px}
.mcap{text-align:center;margin:0}
.warn{background:var(--cream-md);border-radius:10px;padding:12px 14px;font-size:13.5px;color:var(--ink-soft);margin:18px 0}
.warn b{color:var(--ink)}
.wait{display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--muted);margin:14px 0 0}
.wait::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--amber);flex:0 0 auto;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.2}}
.codes{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;list-style:none;background:var(--cream-md);border-radius:10px;padding:14px 18px;margin:0 0 12px;font:600 14px var(--font-mono);letter-spacing:.05em;user-select:all}
.check{display:flex;gap:10px;align-items:center;font-size:14px;margin:16px 0;cursor:pointer}
.check input{width:18px;height:18px;margin:0;accent-color:var(--seal-fill)}
.badge{width:58px;height:58px;border-radius:50%;background:var(--amber-soft);color:var(--amber-deep);display:grid;place-items:center;margin:0 0 18px}
.badge svg{width:24px;height:24px}.badge.no{background:var(--cream-md);color:var(--rose)}
.badge.av{width:58px;height:58px;font-size:24px;border:none}
.note{font-size:12.5px;color:var(--muted);margin:16px 0 0}
.cardfoot{display:flex;justify-content:space-between;gap:10px;margin-top:26px;padding-top:14px;border-top:1px solid var(--line-soft);font:500 10.5px var(--font-mono);letter-spacing:.05em;color:var(--muted)}
.foot{font-size:13px;color:var(--muted);padding-bottom:28px}
.foot nav{display:flex;gap:8px;flex-wrap:wrap}
.foot nav a{font:600 10px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;text-decoration:none;border:1px solid var(--line-soft);border-radius:5px;padding:3px 7px}
.foot nav a:hover{border-color:var(--line);color:var(--ink)}
@media (max-width:920px){.layout{grid-template-columns:minmax(0,1fr);justify-items:center;align-items:start;padding:4px 16px 28px}.intro{display:none}.card{width:100%;max-width:456px}}
@media (max-width:520px){.top{padding:16px 18px}.mark{font-size:12px;gap:9px}.card{padding:22px 20px 14px;border-radius:14px}h2{font-size:27px}.match{font-size:60px}.foot{padding:4px 18px 24px;flex-direction:column;gap:10px}.codes{gap:8px 12px;padding:12px 14px;font-size:13px}}
@media (prefers-reduced-motion:reduce){.wait::before{animation:none}.btn{transition:none}}
`
const PALETTE = tokensUsedBy(STYLE)

const LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6.5a4 4 0 0 1 8 0V10"/></svg>'
const WAY_ICONS: Readonly<Record<'web' | 'desktop' | 'cli', string>> = {
  web: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>',
  desktop: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  cli: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 3 2.5-3 2.5M12.5 15.5h4"/>'
}
const wayIcon = (key: keyof typeof WAY_ICONS): string =>
  `<i class="ico" data-way="${key}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WAY_ICONS[key]}</svg></i>`

/** The host a person reads in the lock label: never a path, never a scheme. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

const FONT_FACES = (version: string): string =>
  `@font-face{font-family:'Inter';font-style:normal;font-weight:400 700;font-display:optional;src:url(/assets/inter.woff2?v=${version}) format('woff2')}` +
  `@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400 700;font-display:optional;src:url(/assets/jetbrains-mono.woff2?v=${version}) format('woff2')}`

export function authPageHtml(opts: AuthPageOptions): string {
  const product = esc(opts.productOrigin.replace(/\/+$/, ''))
  const version = encodeURIComponent(opts.assetVersion)
  const path = opts.path === '/device' ? '/device' : '/'
  const legal = LEGAL_PUBLISHED
    ? `<a href="${product}/privacy">Privacy</a><a href="${product}/terms">Terms</a>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Cookrew</title><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f4efe4" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#15130f" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${FONT_FACES(version)}
${PALETTE}${STYLE}</style>
<script src="/assets/auth.js?v=${version}" defer></script>
</head>
<body data-path="${path}" data-product="${product}" data-legal="${LEGAL_PUBLISHED ? '1' : ''}">
<header class="top"><a class="mark" href="${product}/" aria-label="Cookrew home">${BRAND_MARK_SVG}<span>COOKREW</span></a>
<span class="lock">${LOCK}${esc(hostOf(opts.authOrigin))}</span></header>
<main class="layout">
<aside class="intro"><p class="kick">A little less friction.</p>
<h1>One account.<br>Everywhere<br>you <em>work.</em></h1>
<p class="sub">Your teams, your devices, your work. One familiar way in, wherever you are.</p>
<div class="crew" aria-hidden="true"><span class="avs"><span class="av">M</span><span class="av b">A</span><span class="av c">S</span></span><span class="cap">Your account. Your crew.</span></div>
<div class="ways" aria-hidden="true">${wayIcon('web')}<b></b>${wayIcon('desktop')}<b></b>${wayIcon('cli')}<span class="cap">Web · Desktop · Terminal</span></div></aside>
<section class="card" aria-label="Cookrew sign-in">
<div class="who" id="who" hidden></div>
<div id="screen" aria-live="polite"><p class="said calm">Reading this sign-in…</p>
<noscript><h2>This page needs JavaScript.</h2><p class="lede">Signing in runs a passkey and a few checks in your browser. Turn JavaScript on for auth.cookrew.dev, then reload.</p></noscript></div>
<div class="cardfoot"><span>Your credentials stay private.</span><span>Cookrew account</span></div>
</section>
</main>
<footer class="foot"><span>© Cookrew</span><nav aria-label="Cookrew"><a href="${product}/">cookrew.dev</a>${legal}</nav></footer>
</body></html>`
}
