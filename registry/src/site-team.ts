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
 * THE ONE ACT (owner, 2026-10-04: too many buttons — one per reader, a path
 * of three steps at most). It is rendered INSIDE the line's gate card, which
 * used to be a status while a bar above repeated the act: now there is one
 * place. The card carries id="seatbar" so site.js's verbs bind to it, and the
 * sentence names the reader. line.js owns gate-h / gate-p / gate-actions and
 * rewrites them as the line's state changes; the reader's sentence and act
 * live in seat-head / seat-act, which it never replaces — it only hides the
 * act while it is showing buttons of its own (retry, pay).
 *
 *   stranger   Sign in to open                  (the account sheet, then reload)
 *   owner      Open the line                    (no seat, no charge)
 *   seated     Open the line                    (seat since …)
 *   admitted   Open the line                    (free, signed in)
 *   unseated   Buy a seat · $N  · or ask @owner (W6: the ask is a request)
 *
 * Offline or off the relay: no act but the sentence (and, off the relay, the
 * app link, because the app is the only thing that can carry that line).
 */
function gateAct(input: TeamInput, door: ListedDoor, standing: Standing, live: ReturnType<typeof lineFace>, name: string): { attrs: string; text: string; actions: string } {
  const seated = input.seated ?? []
  const seat = input.seat ?? null
  const price = door.priceUsd ?? ''
  const team = `@${door.handle}/${door.name}`
  // Off the relay the app is the only thing that can carry the line, so the
  // act is the app link. Offline keeps the reader's own act: pressing it says
  // "nobody is serving" (site.js), which is truer than hiding the button.
  if (live.phase === 'IN THE APP') {
    return { attrs: `data-team="${esc(team)}"`, text: live.gate.text, actions: `<a class="btn primary" href="#open" data-open="cookrew://import/${esc(name)}">Open in Cookrew</a>` }
  }
  switch (standing.kind) {
    case 'stranger':
      return { attrs: `data-team="${esc(team)}"`, text: 'Sign in with your cookrew.dev account; the door mints a sandboxed session of your own. A seat is yours, not a browser’s — it follows you to any device.', actions: `<button class="btn primary" data-signin>Sign in to open</button>` }
    case 'owner':
      return { attrs: `data-team="${esc(team)}" data-owner="1"`, text: `You are @${esc(standing.account)} · Your team · ${seated.length} seated — the line is yours, with no seat and no charge.`, actions: `<button class="btn primary" data-seat-open>Open the line</button>` }
    case 'seated':
      return { attrs: `data-team="${esc(team)}"`, text: `You are @${esc(standing.account)} · Seat since ${esc(day(seat?.createdAt ?? standing.since))} — your session continues where you left it.`, actions: `<button class="btn primary" data-seat-open>Open the line</button>` }
    case 'admitted':
      return { attrs: `data-team="${esc(team)}"`, text: `You are @${esc(standing.account)} · this team charges nothing — the line is yours.`, actions: `<button class="btn primary" data-seat-open>Open the line</button>` }
    case 'unseated':
      return {
        attrs: `data-team="${esc(team)}" data-owner="${esc(door.handle)}" data-asked-head="${esc(webCopy('w6.asked-head', { handle: door.handle }))}" data-already-asked="${esc(webCopy('w6.already-asked', { handle: '{handle}' }))}"`,
        text: `You are @${esc(standing.account)} · no seat here yet. A seat is ${esc(price)} USD, once, and follows you to any device.`,
        actions: `<button class="btn primary" data-seat-buy id="seat-buy">Buy a seat · $${esc(price)}</button><a class="ask" href="#ask" data-seat-ask>Ask @${esc(door.handle)}</a>`
      }
  }
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
  const act = gateAct(input, door, standing, line, name)
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
<div class="tp-head one">
<h1 style="margin-bottom:6px">${esc(door.title)}</h1>
<p class="lede" style="margin-bottom:8px"><b>${esc(door.door)}</b> answers for ${door.agents} agent${door.agents === 1 ? '' : 's'} · by <a href="/${esc(door.handle)}">@${esc(door.handle)}</a>${door.summary ? ` · ${esc(door.summary)}` : ''}</p>
<p class="row meta" style="margin:0 0 14px"><span class="led${off ? ' off' : ''}" id="led"></span><span id="livetxt">${off ? 'Not taking calls right now — the address stays valid' : 'taking calls'}</span><span class="chip">${seatLine}</span></p>
</div>
<div class="overlay" id="overlay">
<div class="bar"><span class="led${off ? ' off' : ''}" id="bar-led"></span><span class="name">${esc(door.door)}</span><span class="chip" id="phase">${esc(line.phase)}</span><span class="sp"></span><button class="btn sm" id="btn-new" hidden>⏎ start a new session</button><button class="btn sm danger" id="btn-end" hidden>End session</button></div>
<div class="strip" id="strip"><span id="strip-opened">not opened</span><span class="sep">·</span><span class="state" id="state">${esc(line.state)}</span></div>
<div class="term">
<div class="out" id="term"></div>
<div class="gate" id="gate"><div class="card" id="seatbar" ${act.attrs}><h3 id="gate-h">${esc(line.gate.title)}</h3><p id="gate-p"></p><p id="seat-head">${act.text}</p><p class="row acts" id="seat-act">${act.actions}</p><p class="row acts" id="gate-actions"><button class="btn primary" id="btn-open" hidden${line.gate.disabled ? ' disabled' : ''}>Open the line</button></p><p class="meta" id="seat-ask-note" hidden>${esc(webCopy('w6.asked'))}</p></div></div>
<div class="in"><input id="prompt" placeholder="type to ${esc(door.door)} — Enter sends" disabled autocomplete="off"><button class="btn sm primary" id="send" disabled hidden>Send</button></div>
</div>
<div class="rail"><div class="rh"><span>Checkpoints</span><span id="rail-n">0</span></div><ol id="rail"><li class="live ended" id="rail-tail"><span class="n">—</span><span class="t"><span class="dot"></span>no session</span></li></ol></div>
</div>
<pre class="crt" id="block" hidden style="margin-top:12px;padding:12px 14px;white-space:pre-wrap;max-height:360px;overflow:auto"></pre>
<p class="meta tp-foot"><span class="mono">${esc(address)}</span><button class="star${input.starred ? ' on' : ''}" id="star" data-star="${esc(door.handle)}/${esc(door.name)}" title="one star per account">★ <span>${input.stars}</span></button><a href="#open" data-open="cookrew://import/${esc(name)}">Open in Cookrew</a></p>
</div>`
  )
}
