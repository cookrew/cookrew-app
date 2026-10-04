import { webCopy } from './v3-copy'
import type { ListedDoor } from './site'
import { priceChip } from './site-home'
import { day, esc, page, type Page } from './site-shell'
import { breadcrumbs, organization, teamProduct, webPage } from './site-seo'
import { lineFace, standingOf, type Standing } from './site-standing'
import type { V2Seat } from './v2-seats'

/**
 * A SERVED TEAM'S PAGE — the door's own terminal, on the web.
 *
 * The centre of the page is the LINE: the orchestrator's real PTY, reached
 * through the relay exactly as a placed card reaches it, drawn by xterm.js,
 * with the checkpoint rail beside it. Everything the placed card shows, this
 * page shows with the same words; everything the placed card refuses (fork,
 * rewind, the roster) this page does not offer.
 *
 * WHAT THE PAGE MAY SAY is still bounded by what the owner published — a
 * title, the door's name, how many agents stand behind it, the price, a
 * summary, tags and harness names. It never lists the roster, never shows
 * another caller's transcript, and never implies the reader is entitled to
 * anything: the sign-in, the price and the owner's lending limit are all
 * still ahead of them, and they are decided at the owner's machine.
 *
 * THE LINE OPENS ON A CLICK, never on load. The script on this page can act,
 * which is why this document alone carries a script-src; the rule "a page
 * cannot open a session by itself" holds because opening one is a button.
 */

export interface TeamInput {
  door: ListedDoor | null
  origin: string
  stars: number
  /** Whether the signed-in reader starred it; false for a stranger. */
  starred: boolean
  account: string | null
  /** The reader's own active seat here, when they hold one. */
  seat?: V2Seat | null
  /** Who is in the room — only ever passed when the reader may see it. */
  seated?: readonly string[]
  /** Every seat this team ever had. The owner's list; empty for everyone else. */
  seats?: readonly V2Seat[]
  /** Whether the reader owns this team. */
  owner?: boolean
  /** `?ask=` — the username a guest copied a link to be seated under. */
  ask?: string | null
}

/**
 * THE SEAT BAR (W2) — the same address, rendered by what the request holds.
 *
 * Five states, decided here rather than by a script, because the CSP forbids
 * an inline one and because a page that said "buy a seat" and then changed its
 * mind after a fetch has already told the reader something untrue. The gate
 * order is written into the buttons: sign in, then a seat, then payment, then
 * the line.
 *
 * The BUY and OPEN buttons do not invent a ceremony — they press the line's
 * own entry below, which is where the door's 402 and its session already live.
 */
function seatBar(input: TeamInput, door: ListedDoor, address: string, standing: Standing): string {
  const owner = standing.kind === 'owner'
  const seat = input.seat ?? null
  const seated = input.seated ?? []
  const paid = door.access === 'paid'
  const price = door.priceUsd ?? ''

  // ONE STRIP, ONE ACT (owner, 2026-10-04: keep the least interaction and the core).
  // Sign in · open · buy or ask — a sentence and the button. Seats are managed
  // in the app's account sheet, not here; the room is a count, not a list.
  if (standing.kind === 'stranger' || input.account === null) {
    return `<section class="seat strip" id="seatbar" data-team="${esc(`@${door.handle}/${door.name}`)}">
<span class="meta">A seat is yours, not a browser’s — sign in so it follows you.</span>
<button class="btn primary" data-signin>Sign in to open</button></section>`
  }

  if (owner) {
    return `<section class="seat strip" id="seatbar" data-team="${esc(address)}" data-owner="1">
<span class="chip amber">Your team</span><span class="meta">${seated.length} seated · the line is yours, no seat and no charge.</span>
<button class="btn primary" data-seat-open>Open the line</button></section>`
  }

  if (seat !== null || !paid) {
    const since = seat === null ? 'free to open — you are signed in.' : `Seat since ${esc(day(seat.createdAt))}.`
    return `<section class="seat strip" id="seatbar" data-team="${esc(address)}">
<span class="meta">You are @${esc(input.account)} · ${since}</span>
<button class="btn primary" data-seat-open>Open the line</button></section>`
  }

  // W6 · ASK IS A REQUEST (R1): it files to the owner's queue and reaches every
  // device they have. Both states ship in the markup and site.js unhides one,
  // because the CSP forbids an inline script and the asked state is reachable
  // on a reload. There is no withdraw, because no route retracts a request.
  return `<section class="seat strip" id="seatbar" data-team="${esc(address)}" data-owner="${esc(door.handle)}"
  data-asked-head="${esc(webCopy('w6.asked-head', { handle: door.handle }))}"
  data-already-asked="${esc(webCopy('w6.already-asked', { handle: '{handle}' }))}">
<span class="meta" id="seat-head">You are @${esc(input.account)} · no seat here yet</span>
<span class="sp"></span>
<button class="btn primary" data-seat-buy id="seat-buy">Buy a seat · $${esc(price)}</button>
<button class="btn" data-seat-ask>Ask @${esc(door.handle)}</button>
<span class="meta" id="seat-ask-note" hidden>${esc(webCopy('w6.asked'))}</span></section>`
}

export function teamPage(input: TeamInput): Page {
  const { door } = input
  if (!door) {
    return page(
      { title: 'Not serving — Cookrew', kind: 'document', active: 'market', cache: 0, status: 404, noindex: true },
      `<div class="wrap" style="padding-top:44px"><h1>Not serving</h1>
<p class="lede">No team is taking calls at that address.</p>
<p class="meta">It may have been withdrawn, or it may never have existed. Those
answer the same, so the directory cannot be used to enumerate what is here.</p></div>`
    )
  }
  const address = `${input.origin}/${door.handle}/${door.name}`
  const name = `@${door.handle}/${door.name}`
  const off = door.live === false
  const harnesses = door.harnesses ?? []
  const tags = door.tags ?? []
  const relayed = door.transport === 'relay' && typeof door.sealKey === 'string'
  // WHO IS READING, decided once. The seat bar, the line's chip, the strip and
  // the gate all render from this, so none of them can contradict another —
  // which is precisely what they used to do (site-standing.ts).
  const standing = standingOf(input, door)
  const line = lineFace(standing, {
    name,
    orch: door.door,
    handle: door.handle,
    live: !off,
    relayed,
    price: door.priceUsd ?? ''
  })
  // THE GATE CARD IS A STATUS, NOT A SECOND DOOR. The seat bar above the line
  // is the one place that offers buy / ask / sign in / open; the card inside
  // the terminal says where the line stands and keeps the line's own entry
  // (`btn-open`, which line.js and the bar's buttons press) out of sight, so
  // the page never shows two buttons for one act. line.js still swaps real
  // buttons into `gate-actions` for the states only it can know (retry, pay).
  const gateText = line.phase === 'NO SEAT' ? `A seat first — buy one above, or ask @${door.handle}.` : line.gate.text
  const seatLine = door.access === 'paid' && door.priceUsd ? `${esc(door.priceUsd)} USD · a seat, once` : 'free · account needed'
  return page(
    {
      title: `${door.title} — @${door.handle} · Cookrew`,
      kind: 'app',
      active: 'market',
      account: input.account,
      scripts: ['xterm.js', 'addon-fit.js', 'device-id.js', 'site.js', 'seal.js', 'line.js'],
      styles: ['xterm.css'],
      cache: 0,
      description: `${door.title}: ${door.door} answers on behalf of ${door.agents} agent${door.agents === 1 ? '' : 's'} served by @${door.handle} on Cookrew. ${door.summary ?? 'Open a live, sandboxed session from your browser or the Cookrew app.'}`.slice(0, 158),
      path: `/${door.handle}/${door.name}`,
      jsonLd: [
        organization(),
        webPage({ path: `/${door.handle}/${door.name}`, name: door.title, description: door.summary ?? `${door.title}, a served AI agent team on Cookrew.` }),
        breadcrumbs([{ name: 'Cookrew', path: '/' }, { name: 'Marketplace', path: '/market' }, { name: `@${door.handle}`, path: `/${door.handle}` }, { name: door.title, path: `/${door.handle}/${door.name}` }]),
        teamProduct(door, input.stars)
      ]
    },
    `<div class="wrap" style="padding-top:30px" id="team" data-door="${esc(name)}" data-seal-key="${esc(door.sealKey ?? '')}" data-live="${off ? '0' : '1'}" data-access="${esc(door.access)}" data-price="${esc(door.priceUsd ?? '')}" data-orch="${esc(door.door)}" data-relayed="${relayed ? '1' : '0'}">
<div class="tp-head">
<div><p class="meta" style="margin:0 0 6px"><a href="/market">Marketplace</a> / <a href="/${esc(door.handle)}">@${esc(door.handle)}</a></p>
<h1 style="margin-bottom:6px">${esc(door.title)}</h1>
<p class="lede" style="margin-bottom:10px"><b>${esc(door.door)}</b> answers for ${door.agents} agent${door.agents === 1 ? '' : 's'}.${door.summary ? ` ${esc(door.summary)}` : ''}</p>
<div class="row"><span class="led${off ? ' off' : ''}" id="led"></span><span id="livetxt" class="meta">${off ? 'Not taking calls right now — the address stays valid' : 'taking calls'}</span><span class="chip">${esc(door.transport)}</span>${harnesses.map((h) => `<span class="chip">${esc(h)}</span>`).join('')}${door.access === 'paid' ? door.rails.map((rail) => `<span class="chip">${rail === 'x402' ? 'USDC · wallet' : 'card'}</span>`).join('') : ''}${tags.map((t) => `<span class="chip violet">${esc(t)}</span>`).join('')}</div></div>
<div class="tp-actions"><button class="star${input.starred ? ' on' : ''}" id="star" data-star="${esc(door.handle)}/${esc(door.name)}" title="one star per account">★ <span>${input.stars}</span></button><a class="btn primary lg" id="open" href="#open" data-open="cookrew://import/${esc(name)}">Open in Cookrew</a></div>
</div>

${seatBar(input, door, name, standing)}
<div class="tp one">
<div>
<div class="overlay" id="overlay">
<div class="bar"><span class="led${off ? ' off' : ''}" id="bar-led"></span><span class="name">${esc(door.door)}</span><span class="chip violet">ORCH · THE DOOR</span><span class="chip" id="phase">${esc(line.phase)}</span><span class="sp"></span><button class="btn sm" id="btn-new" hidden>⏎ start a new session</button><button class="btn sm danger" id="btn-end" hidden>End session</button></div>
<div class="strip" id="strip"><span id="strip-opened">not opened</span><span class="sep">·</span><span>${seatLine}</span><span class="sep">·</span><span>runs at ${esc(name)}</span><span class="sep">·</span><span class="state" id="state">${esc(line.state)}</span></div>
<div class="term">
<div class="out" id="term"></div>
<div class="gate" id="gate"><div class="card"><h3 id="gate-h">${esc(line.gate.title)}</h3><p id="gate-p">${esc(gateText)}</p><p class="row" style="justify-content:center" id="gate-actions"><button class="btn primary" id="btn-open" hidden${line.gate.disabled ? ' disabled' : ''}>Open the line</button></p></div></div>
<div class="in"><input id="prompt" placeholder="type to ${esc(door.door)} — Enter sends; keystrokes go raw to the PTY" disabled autocomplete="off"><button class="btn sm primary" id="send" disabled>Send</button></div>
</div>
<div class="rail"><div class="rh"><span>Checkpoints</span><span id="rail-n">0</span></div><ol id="rail"><li class="live ended" id="rail-tail"><span class="n">—</span><span class="t"><span class="dot"></span>no session</span></li></ol></div>
</div>
<pre class="crt" id="block" hidden style="margin-top:12px;padding:12px 14px;white-space:pre-wrap;max-height:360px;overflow:auto"></pre>
<div class="addr" style="margin-top:12px"><span id="addr">${esc(address)}</span><button class="btn sm" data-copy="${esc(address)}">copy</button></div>
</div>
</div></div>`
  )
}
