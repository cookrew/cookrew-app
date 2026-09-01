import type { DoorRecord } from './doors'

/**
 * THE PUBLIC FACE OF cookrew.dev.
 *
 * Three documents, all generated from what the registry already knows: the
 * front page, an owner's page, and a served team's page. Nothing here is
 * hand-maintained, because the thing it describes changes every time somebody
 * serves a team — a page written by hand would be wrong by the afternoon.
 *
 * THEY ARE DOCUMENTS, not an app. No script, no form, no handler attribute,
 * and a CSP that forbids all three. A page cannot express "open this for me"
 * and must not pretend to: opening a team is something the app does, after a
 * person decides. The page's whole job is to let them decide.
 *
 * WHAT A TEAM'S PAGE MAY SAY is bounded by what the owner published — a title,
 * the door's name, how many agents stand behind it, and the price. It never
 * lists the roster, never shows a transcript, and never implies the reader is
 * entitled to anything: the sign-in, the price and the owner's lending limit
 * are all still ahead of them, and they are decided at the owner's machine.
 */

/** Escape for HTML text AND for a double-quoted attribute — one function. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Top-level names a handle may never take.
 *
 * An owner's page lives at /<handle>, so a handle called `v1` would shadow the
 * API and one called `install` would shadow the install page. Reserved here
 * rather than at registration alone, so an old record that predates a new route
 * still cannot capture it.
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
  'admin'
])

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

export interface Page {
  status: number
  headers: Record<string, string>
  body: string
}

function page(status: number, title: string, main: string, cache = 60): Page {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Everything here describes mutable state — a team can be served or
      // withdrawn between two refreshes — so it is cached briefly or not at all.
      'cache-control': `public, max-age=${cache}`
    },
    body: shell(title, main)
  }
}

/** One stylesheet for all three documents; a second would drift from the first. */
const STYLE = `
:root{--bg:#faf9f5;--panel:#fff;--ink:#16150f;--dim:#5f5d52;--line:#e4e0d3;
--accent:#1e6f49;--code:#f2f0e8;--shadow:0 1px 2px rgba(0,0,0,.05),0 10px 30px rgba(0,0,0,.045)}
@media (prefers-color-scheme:dark){:root{--bg:#111209;--panel:#191b13;--ink:#eceadd;
--dim:#9c9a8b;--line:#2b2e24;--accent:#6fd39b;--code:#0e1008;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.65 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:40px 22px 80px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace;background:var(--code);
padding:2px 6px;border-radius:5px;font-size:.9em}
header.site{display:flex;align-items:baseline;gap:14px;margin-bottom:40px}
.mark{font:700 17px ui-monospace,Menlo,monospace;letter-spacing:.16em;color:var(--ink)}
.mark span{color:var(--accent)}
.tag{color:var(--dim);font-size:13.5px}
h1{font-size:clamp(28px,4.6vw,44px);line-height:1.15;letter-spacing:-.025em;margin:0 0 16px}
h2{font:600 12px ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;
color:var(--dim);margin:48px 0 14px}
h3{font-size:17px;margin:0 0 6px}
p{max-width:70ch}
.lede{font-size:19px;color:var(--dim);max-width:64ch}
.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;
padding:20px 22px;box-shadow:var(--shadow)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));margin:14px 0}
.grid .card p{color:var(--dim);font-size:14.5px;margin:0}
.door{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 16px;margin:0 0 6px}
.door .name{font-size:20px;font-weight:650}
.price{font:600 13px ui-monospace,Menlo,monospace;color:var(--accent);
border:1px solid var(--line);border-radius:999px;padding:3px 11px}
.free{color:var(--dim)}
.meta{color:var(--dim);font-size:14px;margin:0}
ul.doors{list-style:none;padding:0;margin:14px 0}
ul.doors li{border-bottom:1px solid var(--line);padding:16px 0}
ul.doors li:last-child{border-bottom:none}
.addr{display:block;background:var(--code);border:1px solid var(--line);border-radius:9px;
padding:12px 14px;font-family:ui-monospace,Menlo,monospace;font-size:14px;
overflow-x:auto;white-space:nowrap;margin:14px 0}
.rails{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0;padding:0;list-style:none}
.rails li{font:600 11.5px ui-monospace,Menlo,monospace;letter-spacing:.06em;
border:1px solid var(--line);border-radius:6px;padding:4px 9px;color:var(--dim)}
.empty{color:var(--dim);font-style:italic}
footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);
color:var(--dim);font-size:13.5px}
`

function shell(title: string, main: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
<header class="site"><a class="mark" href="/">COOK<span>REW</span></a>
<span class="tag">an open-source spatial workspace for AI agents</span></header>
${main}
<footer>cookrew.dev · <a href="/v1/doors">the directory, as data</a></footer>
</div></body></html>`
}

/**
 * THE FRONT PAGE.
 *
 * The claim it opens with is the one the product actually makes, and it is a
 * comparison because that is how anybody arrives here: they already have a
 * chat tab, and the question is why they would want anything else.
 */
export function homePage(doors: readonly DoorRecord[]): Page {
  const serving = doors.length
  const live =
    serving === 0
      ? `<p class="empty">Nobody is serving a team here yet.</p>`
      : `<ul class="doors">${doors.slice(0, 8).map(doorRow).join('')}</ul>`

  return page(
    200,
    'Cookrew — a team of AI agents on one canvas',
    `
<h1>A chat tab gives you one assistant.<br>Cookrew gives you a team.</h1>
<p class="lede">
  Put Claude Code, Codex, OpenCode and Pi on one canvas. Wire them together,
  give them roles, and watch the whole crew work. Then pack the team up, copy
  it, or serve it to someone else.
</p>

<h2>What is on the canvas</h2>
<div class="grid">
  <div class="card"><h3>Agent terminals</h3>
    <p>Every black card is a real terminal running a real agent, with a name and
    a role. Five presets ship in the dock; mixing them in one team is the point.</p></div>
  <div class="card"><h3>Notes and browsers</h3>
    <p>Specs, review conclusions and handover docs live beside the agent they
    are about. Design files and reports sit on the canvas, not in a folder.</p></div>
  <div class="card"><h3>Wires are the org chart</h3>
    <p>Who hands work to whom, and who reviews whom, is something you can see
    rather than something you remember.</p></div>
</div>

<h2>Every turn is a checkpoint</h2>
<p>
  Scrub back through a session, fork a new agent from any past turn, and pin a
  version the moment a team is exported or called. The one rule the product
  never breaks: <strong>exporting or calling never touches the original
  session</strong> — everything is a fork. A night of context becomes an asset
  instead of something fragile.
</p>

<h2>Orchestration is a command line</h2>
<p>
  People and agents share one CLI, so an orchestrating agent can run the same
  commands you can — which is what makes "a commander leading a crew" a native
  way to work rather than a metaphor.
</p>
<code class="addr">$ cookrew recruit "Reviewer" --preset "Claude Code"
$ cookrew connect "Forge" "Reviewer"
$ cookrew ask "Reviewer" "review Forge's latest commit"</code>

<h2>Somebody else's crew, working for you</h2>
<p>
  A team stays on its author's machine. You sign in with a passkey, pay per
  session if it is priced, and get a live sandboxed session of your own — the
  author can end it at any time. Money goes from the caller straight to the
  author; this registry never holds it.
</p>

<h2>Serving right now${serving > 0 ? ` · ${serving}` : ''}</h2>
${live}
`
  )
}

/** One line in a list of doors — used by the front page and an owner's page. */
function doorRow(door: DoorRecord): string {
  const at = `/${esc(door.handle)}/${esc(door.name)}`
  return `<li>
<p class="door"><a class="name" href="${at}">${esc(door.title)}</a>
${priceChip(door)}</p>
<p class="meta">by <a href="/${esc(door.handle)}">${esc(door.handle)}</a> ·
one door: ${esc(door.door)} · ${door.agents} agent${door.agents === 1 ? '' : 's'}</p>
</li>`
}

function priceChip(door: DoorRecord): string {
  return door.access === 'paid' && door.priceUsd
    ? `<span class="price">${esc(door.priceUsd)} USD · per session</span>`
    : `<span class="price free">free · account needed</span>`
}

/** AN OWNER'S PAGE — who they are, and what they are serving. */
export function handlePage(handle: string, doors: readonly DoorRecord[]): Page {
  if (doors.length === 0) {
    return page(
      404,
      `${handle} — Cookrew`,
      `<h1>@${esc(handle)}</h1>
<p class="lede">Nobody by that name is serving a team here.</p>
<p class="meta">A handle with nothing served looks exactly like a handle that
was never taken — that is deliberate, so this page cannot be used to find out
who has an account.</p>`,
      0
    )
  }
  return page(
    200,
    `${handle} — Cookrew`,
    `<h1>@${esc(handle)}</h1>
<p class="lede">${doors.length} team${doors.length === 1 ? '' : 's'} taking calls.</p>
<ul class="doors">${doors.map(doorRow).join('')}</ul>`
  )
}

/**
 * A SERVED TEAM'S PAGE.
 *
 * The address is shown as something to copy INTO Cookrew rather than as a link
 * to click, because clicking it lands back here — the team is not on the web,
 * it is on its author's machine, and this page is only the sign that says so.
 */
export function doorPage(door: DoorRecord | null, origin: string): Page {
  if (!door) {
    return page(
      404,
      'Not serving — Cookrew',
      `<h1>Not serving</h1>
<p class="lede">No team is taking calls at that address.</p>
<p class="meta">It may have been withdrawn, or it may never have existed. Those
answer the same, so the directory cannot be used to enumerate what is here.</p>`,
      0
    )
  }
  const address = `${origin}/${door.handle}/${door.name}`
  const rails =
    door.access === 'paid' && door.rails.length > 0
      ? `<ul class="rails">${door.rails
          .map((rail) => `<li>${rail === 'x402' ? 'USDC · wallet' : 'card'}</li>`)
          .join('')}</ul>`
      : ''

  return page(
    200,
    `${door.title} — Cookrew`,
    `<p class="door"><span class="name" style="font-size:15px;color:var(--dim)">
<a href="/${esc(door.handle)}">@${esc(door.handle)}</a></span></p>
<h1>${esc(door.title)}</h1>
<p class="lede">${esc(door.door)} answers, on behalf of
${door.agents} agent${door.agents === 1 ? '' : 's'} standing behind it.</p>

<h2>How to reach it</h2>
<p>Paste this into Cookrew — Import a served team.</p>
<code class="addr">${esc(address)}</code>
<p class="meta">
  The team runs on its author's machine. Opening it gives you a live session of
  your own, in a sandbox; the author can end it whenever they like, and nothing
  of theirs comes to you.
</p>

<h2>What it costs</h2>
<div class="card">
<p class="door">${priceChip(door)}</p>
${
  door.access === 'paid'
    ? `<p class="meta">Charged once, when a session starts — never per question.
An open session is never interrupted for money.</p>${rails}
<p class="meta" style="margin-top:12px">Payment goes from you to the author
directly. This registry does not hold it and takes nothing from it.</p>`
    : `<p class="meta">Free to call. You still sign in, because the author lends
their machine to accounts rather than to anyone who finds the address.</p>`
}
</div>

<h2>One door</h2>
<p>
  A team has exactly one interface: its orchestrator, <strong>${esc(door.door)}</strong>.
  The roster behind it is never listed and never reachable — you talk to the
  door, and the door decides what the crew does.
</p>
`
  )
}
