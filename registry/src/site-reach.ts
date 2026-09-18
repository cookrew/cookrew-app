import { esc } from './site-shell'
import { webCopy } from './v3-copy'
import type { V2Desktop } from './v2-accounts'

/**
 * THE DESKTOPS ROW ON /me (reach v2.1), AS MARKUP.
 *
 * Name · workspaces · one badge · OPEN. Nothing else, and the "nothing else"
 * is the point: pairing a phone happens on the PHONE, on the companion's own
 * "Not paired" card, with the token the Mac prints. A row on cookrew.dev that
 * offered to scan a QR, to take six characters, to forget a key and to explain
 * why the last key was refused was five controls for a ceremony that no longer
 * exists — and it put the credential in the wrong place besides.
 *
 * THE BADGE IS ONE FACT, AND cookrew.dev IS THE ONE THAT HOLDS IT: is this Mac
 * holding its relay line here right now? That is a question only the registry
 * can answer, it answers it in one cheap request (`relay-status`), and it is
 * the only reachability claim this page can make honestly. Whether a phone can
 * also get to that Mac over Wi-Fi is a question for the phone, and it comes
 * back in phase C3, when the addresses have names a browser will trust.
 *
 * Every state a reader can reach is in the page the server sent — PROBING,
 * ONLINE, OFFLINE — and `reach.js` does nothing but unhide the one that turned
 * out to be true. The CSP forbids an inline script, so a row assembled at load
 * is a row nobody can read in view-source, nobody can style, and nobody can
 * test without a browser.
 *
 * OPEN IS A LINK, not a button that a script turns into a navigation. It has
 * an href in the markup the server sent, it goes to cookrew.dev's own relay
 * prefix, and it carries nothing on the query — no token, no key, no device.
 * Opening a Mac from cookrew.dev never leaves cookrew.dev.
 */

/**
 * The badges the script switches between, in the order the row draws them.
 *
 * LAN IS A DIFFERENT AXIS FROM THE OTHER THREE and it still shares the slot,
 * on purpose. PROBING · ONLINE · OFFLINE answer "is cookrew.dev holding this
 * Mac's line"; LAN answers "and this device can also reach it directly". They
 * share the slot because a reader is asking one question — how does this page
 * get to that Mac — and two badges side by side would make them hunt for which
 * one is the answer. LAN outranks ONLINE when both are true: it is the better
 * path and the one the race will pick.
 */
const BADGES: readonly [state: string, label: string, tone: string][] = [
  ['probing', '◌ PROBING', 'busy'],
  ['online', '● ONLINE', 'ok'],
  ['offline', '○ OFFLINE', ''],
  ['lan', '⚡ LAN', 'ok']
]

const badges = (): string =>
  BADGES.map(
    ([state, label, tone], i) =>
      `<span class="chip${tone === '' ? '' : ` ${tone}`}" data-badge="${state}"${i === 0 ? '' : ' hidden'}>${label}</span>`
  ).join('')

/**
 * WHERE A MAC LIVES ON cookrew.dev. The same prefix the relay session serves
 * under, built here so the row and the relay cannot disagree about it. Both
 * halves are already narrow alphabets in the store; they are encoded anyway,
 * because a path built from stored values is still a path built from values.
 */
export const relayPrefix = (username: string, deviceId: string): string =>
  `/relay/@${encodeURIComponent(username)}/desktop/${encodeURIComponent(deviceId)}/`

/**
 * TODO (V3-13 → V3-18): W5 wants the DOORS this Mac serves on its row, under
 * the workspaces. `V2Desktop` carries no `doors[]` yet — V3-18 adds it, with
 * the save-time conflict and TAKE OVER that make ownership of a door mean
 * something — so this row lists workspaces alone and gains a second line
 * there. Nothing is drawn for it here: an empty "Doors" label on every row
 * would read as a Mac serving nothing rather than as a field that does not
 * exist yet.
 */
function desktopRow(username: string, desktop: V2Desktop): string {
  const workspaces =
    desktop.workspaces.length === 0
      ? 'No workspaces registered yet'
      : desktop.workspaces.map((w) => esc(w.name)).join(' · ')
  const id = esc(desktop.deviceId)
  /**
   * USE WI-FI (M5) — one tap that asks the Mac, and never a scan.
   *
   * It ships in the markup with its three states already here (ask · asked ·
   * allowed) because the CSP forbids an inline script: a control assembled at
   * load is a control nobody can read in view-source and nobody can test
   * without a browser. reach.js only unhides the one that is true.
   *
   * WI-FI OK IS NOT A BUTTON. Once this device holds that Mac's token there is
   * nothing left to ask for, and a button that does nothing is a button people
   * press twice.
   */
  return `<li class="desktop" data-desktop="${id}" data-name="${esc(desktop.name)}">
<span class="chip">Mac</span>
<span><b>${esc(desktop.name)}</b><br><span class="meta">${workspaces}</span></span>
<span class="reach-actions">${badges()}
<a class="btn sm primary" href="${esc(relayPrefix(username, desktop.deviceId))}">OPEN</a>
<button class="btn sm" data-reach="${id}">USE WI-FI</button>
<button class="btn sm" data-reach-cancel="${id}" hidden>CANCEL</button>
<span class="chip ok" data-reach-ok hidden>WI-FI OK</span></span>
<p class="meta reach-note" data-reach-note hidden></p></li>`
}

/**
 * The DESKTOPS section of /me. Empty is a sentence rather than an empty list:
 * a person who has not claimed the username in the app yet should read why
 * there is nothing here, not wonder whether the page is broken.
 */
export function desktopsSection(username: string, desktops: readonly V2Desktop[]): string {
  const rows =
    desktops.length === 0
      ? `<li><span class="meta">No desktop has registered its workspaces yet. Claim this username in the app and they appear here.</span></li>`
      : desktops.map((desktop) => desktopRow(username, desktop)).join('')
  return `<h2 style="margin-top:30px">Desktops</h2>
<p class="meta">Names and workspaces only — cookrew.dev never holds what is on a canvas. ONLINE means that Mac is holding its line at cookrew.dev right now, so OPEN reaches it; opening one stays here, on cookrew.dev. USE WI-FI asks that Mac once for its keyboard on this network; ${esc(webCopy('m5.no-account'))}</p>
<ul class="doors me-list" id="me-desktops"
  data-asked="${esc(webCopy('m5.asked'))}"
  data-allowed="${esc(webCopy('m5.allowed', { device: '{device}' }))}"
  data-declined="${esc(webCopy('m5.declined', { device: '{device}' }))}"
  data-no-seal="${esc(webCopy('m5.no-seal'))}">${rows}</ul>`
}
