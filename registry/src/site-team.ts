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

  if (standing.kind === 'stranger' || input.account === null) {
    return `<section class="card seat" id="seatbar" data-team="${esc(`@${door.handle}/${door.name}`)}">
<h2>Open this team</h2>
<p class="lede" style="margin:0 0 10px">A seat is yours, not a browser’s. Sign in so it follows you.</p>
<p class="row" style="margin:0"><button class="btn primary lg" data-signin>Sign in to open</button></p></section>`
  }

  const room =
    seated.length === 0
      ? ''
      : `<p class="meta" id="seat-room" style="margin:10px 0 0">seated here: ${esc(seated.map((who) => `@${who}`).join(', '))}</p>`

  if (owner) {
    const rows =
      input.seats === undefined || input.seats.length === 0
        ? `<li><span class="chip">Empty</span><span class="meta">Nobody is seated yet. Grant one by username, or share the address.</span><span></span></li>`
        : input.seats
            .map((held) => {
              const gone = held.endedAt !== undefined
              const where =
                held.source === 'bought'
                  ? `bought · ${esc(day(held.createdAt))}`
                  : `granted by you · ${esc(day(held.createdAt))}`
              const action = gone
                ? `<span class="chip">${esc(held.endedAt === undefined ? '' : `ended ${day(held.endedAt)}`)}</span>`
                : `<button class="btn sm danger" data-seat-end="${esc(held.id)}">${held.source === 'bought' ? 'End' : 'Revoke'}</button>`
              return `<li><span class="chip">${esc(held.account.slice(0, 2).toUpperCase())}</span>
<span><b>@${esc(held.account)}</b><br><span class="meta">${where}</span></span>${action}</li>`
            })
            .join('')
    const asked = input.ask ?? ''
    // THE OWNER OPENS FIRST. This bar used to offer an owner nothing but the
    // grant form, while the line below told them to sign in — so they typed
    // their own name into the form and granted themselves a seat at a team
    // the registry admits them to without one. The line is the first thing an
    // owner is offered; the room and the form follow.
    return `<section class="card seat" id="seatbar" data-team="${esc(address)}" data-owner="1">
<h2>Your team · ${seated.length} seated</h2>
<p class="lede" style="margin:0 0 10px">Your own team — the line is yours, with no seat and no charge.</p>
<p class="row" style="margin:0 0 14px"><button class="btn primary lg" data-seat-open>Open the line</button></p>
<p class="meta" style="margin:0 0 10px">A seat is per account and follows the person to any device they sign in on. Ending one stops their next call at the door.</p>
<div class="row" id="seat-grant"><input id="seat-username" value="${esc(asked)}" placeholder="username" autocomplete="off" spellcheck="false" maxlength="32">
<button class="btn primary" data-seat-grant>Grant a seat</button></div>
<ul class="doors me-list" id="seat-list">${rows}</ul></section>`
  }

  if (seat !== null || !paid) {
    const since = seat === null ? 'This team charges nothing — you are signed in, so the line is yours.' : `Seat since ${esc(day(seat.createdAt))} · your session continues where you left it.`
    return `<section class="card seat" id="seatbar" data-team="${esc(address)}">
<h2>You are @${esc(input.account)}</h2>
<p class="lede" style="margin:0 0 10px">${since}</p>
<p class="row" style="margin:0"><button class="btn primary lg" data-seat-open>Open the line</button></p>${room}</section>`
  }

  /**
   * W6 · ASK IS A REQUEST (R1) — it files, it does not copy.
   *
   * The button used to put a link on the clipboard, which left the asker with
   * an errand: find the owner somewhere else and send it to them. The request
   * goes to the owner's one queue instead and reaches every device they have,
   * so the sentence names that rather than describing a paste.
   *
   * BOTH STATES SHIP IN THE MARKUP and site.js unhides one. The CSP forbids an
   * inline script, so a bar assembled at load is a bar nobody can read in
   * view-source; and the asked state is reachable on a RELOAD — this page
   * polls GET …/seat, and somebody who closed the tab and came back must find
   * the bar already waiting rather than a button that would file a second
   * request.
   *
   * THERE IS NO WITHDRAW, and it is left out rather than faked. The design's
   * asked state offers one, but no route retracts a seat request — a button
   * that stopped this tab polling while the request sat in the owner's queue
   * would be a lie told to the only person who believed it. It arrives with
   * the route (see the report).
   */
  return `<section class="card seat" id="seatbar" data-team="${esc(address)}" data-owner="${esc(door.handle)}"
  data-asked-head="${esc(webCopy('w6.asked-head', { handle: door.handle }))}"
  data-already-asked="${esc(webCopy('w6.already-asked', { handle: '{handle}' }))}">
<h2 id="seat-head">You are @${esc(input.account)} · no seat here yet</h2>
<p class="lede" style="margin:0 0 10px" id="seat-lede">${esc(webCopy('w6.no-seat', { handle: door.handle }))}</p>
<p class="row" style="margin:0"><button class="btn primary lg" data-seat-buy id="seat-buy">Buy a seat · $${esc(price)}</button>
<button class="btn lg" data-seat-ask>Ask @${esc(door.handle)}</button></p>
<p class="meta" style="margin:10px 0 0" id="seat-ask-note" hidden>${esc(webCopy('w6.asked'))}</p></section>`
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
  const rails =
    door.access === 'paid' && door.rails.length > 0
      ? `<p class="row" style="margin:8px 0 0">${door.rails.map((rail) => `<span class="chip">${rail === 'x402' ? 'USDC · wallet' : 'card'}</span>`).join('')}</p>`
      : ''
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
  const about =
    door.access === 'paid'
      ? `<p class="meta">A seat is charged once, at the door, and follows you to any device you sign in on — never per question, and an open session is never interrupted for money.</p>${rails}<p class="meta" style="margin-top:10px">Money goes from you to the author directly; cookrew.dev holds none of it.</p>`
      : `<p class="meta">Free to open — you still sign in, because the author lends their machine to accounts rather than to anyone who finds the address.</p>`

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
<div class="row"><span class="led${off ? ' off' : ''}" id="led"></span><span id="livetxt" class="meta">${off ? 'Not taking calls right now — the address stays valid' : 'taking calls'}</span><span class="chip">${esc(door.transport)}</span>${harnesses.map((h) => `<span class="chip">${esc(h)}</span>`).join('')}${tags.map((t) => `<span class="chip violet">${esc(t)}</span>`).join('')}</div></div>
<div class="tp-actions"><button class="star${input.starred ? ' on' : ''}" id="star" data-star="${esc(door.handle)}/${esc(door.name)}" title="one star per account">★ <span>${input.stars}</span></button><a class="btn primary lg" id="open" href="#open" data-open="cookrew://import/${esc(name)}">Open in Cookrew</a></div>
</div>

${seatBar(input, door, name, standing)}
<div class="tp">
<div>
<p class="kicker"><span class="no">LINE</span>this team’s own terminal, bound to cookrew.dev</p>
<div class="overlay" id="overlay">
<div class="bar"><span class="led${off ? ' off' : ''}" id="bar-led"></span><span class="name">${esc(door.door)}</span><span class="chip violet">ORCH · THE DOOR</span><span class="chip" id="phase">${esc(line.phase)}</span><span class="sp"></span><button class="btn sm" id="btn-new" hidden>⏎ start a new session</button><button class="btn sm danger" id="btn-end" hidden>End session</button><a class="btn sm" href="#how">how it works</a></div>
<div class="strip" id="strip"><span id="strip-opened">not opened</span><span class="sep">·</span><span>${seatLine}</span><span class="sep">·</span><span>runs at ${esc(name)}</span><span class="sep">·</span><span class="state" id="state">${esc(line.state)}</span></div>
<div class="term">
<div class="out" id="term"></div>
<div class="gate" id="gate"><div class="card"><h3 id="gate-h">${esc(line.gate.title)}</h3><p id="gate-p">${esc(gateText)}</p><p class="row" style="justify-content:center" id="gate-actions"><button class="btn primary" id="btn-open" hidden${line.gate.disabled ? ' disabled' : ''}>Open the line</button></p></div></div>
<div class="in"><input id="prompt" placeholder="type to ${esc(door.door)} — Enter sends; keystrokes go raw to the PTY" disabled autocomplete="off"><button class="btn sm primary" id="send" disabled>Send</button></div>
</div>
<div class="rail"><div class="rh"><span>Checkpoints</span><span id="rail-n">0</span></div><ol id="rail"><li class="live ended" id="rail-tail"><span class="n">—</span><span class="t"><span class="dot"></span>no session</span></li></ol></div>
</div>
<p class="meta" style="margin-top:10px">The same line a placed card gets: prompt, the reply as the terminal draws it, a checkpoint on the rail. Click a rail row to read that turn’s block. The roster is never listed — you talk to the door.</p>
<pre class="crt" id="block" hidden style="margin-top:12px;padding:12px 14px;white-space:pre-wrap;max-height:360px;overflow:auto"></pre>

<div class="faq" id="how" style="margin-top:18px"><details><summary>How the web line works</summary><ol class="pts how">
<li><b>Sign in.</b> Your cookrew.dev account signs a challenge; the registry mints a token for this one door, <code>${esc(name)}</code>. The door seats you under that account.</li>
<li><b>The ladder.</b> <code>GET /line</code> through the relay: 401 sign in · 403 no seat — buy one or ask the owner · 402 the seat’s price, once · 429 the owner’s lending limit · 410 your session ended, press Enter for a new one.</li>
<li><b>The PTY.</b> A stream of the orch’s real terminal, drawn here by xterm.js; keystrokes go back as <code>/line/raw</code>. Sealed both ways in this browser — the relay carries bytes it cannot read.</li>
<li><b>End.</b> You end it, or the author does. The session workspace on their machine is destroyed either way; the address stays valid for next time.</li>
</ol></details></div>
</div>

<aside class="side">
<div class="card"><h3>About this door</h3><p class="row">${priceChip(door)}</p>${about}<p class="meta" style="margin-top:10px">One interface: its orchestrator, <strong>${esc(door.door)}</strong>. The roster behind it is never listed and never reachable; the relay reads nothing; the author can end any session.</p></div>
<div class="card"><h3>Facts</h3><dl><dt>Owner</dt><dd><a href="/${esc(door.handle)}">@${esc(door.handle)}</a></dd><dt>Door</dt><dd>${esc(door.door)}</dd><dt>Agents</dt><dd>${door.agents}</dd><dt>Reach</dt><dd>${door.transport === 'relay' || door.transport === 'public' ? 'Anyone with the link' : door.transport === 'tailnet' ? 'People on the owner’s tailnet' : 'People on the owner’s network'}</dd>${harnesses.length > 0 ? `<dt>Harnesses</dt><dd>${esc(harnesses.join(', '))}</dd>` : ''}<dt>Last seen</dt><dd><time datetime="${new Date(door.seenAt).toISOString()}">${esc(new Date(door.seenAt).toISOString().slice(0, 16).replace('T', ' '))} UTC</time></dd></dl>
<div class="addr" style="margin-top:12px"><span id="addr">${esc(address)}</span><button class="btn sm" data-copy="${esc(address)}">copy</button></div></div>
<p class="row"><a class="btn primary" href="#open" data-open="cookrew://import/${esc(name)}">Open in Cookrew</a><a class="btn" href="/#download">Get the app</a></p>
<p class="meta" style="margin:8px 0 0">In the app the card gets the same rail and transcript as a preset card, fed from the door’s record.</p>
</aside>
</div></div>`
  )
}
