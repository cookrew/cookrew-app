import { esc } from './site-shell'
import type { V2Desktop } from './v2-accounts'

/**
 * THE DESKTOP PICKER ON cookrew.dev (M3), AS MARKUP.
 *
 * Every state a reader can reach is in the page the server sent — probing,
 * LAN, tailnet, relay, offline, needs pairing — and `reach.js` does nothing
 * but unhide the one that turned out to be true. That is not tidiness: the
 * CSP forbids an inline script, so a picker assembled at load is a picker
 * nobody can read in view-source, nobody can style, and nobody can test
 * without a browser.
 *
 * The BADGE IS NOT A FACT THE REGISTRY HAS. cookrew.dev knows the addresses a
 * desktop published; whether this phone, on this network, behind this proxy,
 * can reach any of them is only knowable from inside the page. So the server
 * ships the card and the states, and the page races them.
 */

/** M1's sentence, over the two pairing actions. */
export const PAIR_SENTENCE = 'Open the avatar on the Mac → Pair a phone. Then:'
/** What a desktop says when the six characters were yesterday's. */
export const WRONG_KEY_SENTENCE = 'Not this Mac’s key — it changes every two minutes.'

const BADGES: readonly [string, string, string][] = [
  ['probing', '◌ PROBING', 'busy'],
  ['lan', '● LAN', 'ok'],
  ['tailnet', '● TAILNET', 'violet'],
  ['relay', '● RELAY', 'amber'],
  ['offline', '○ OFFLINE', ''],
  ['pairing', 'NEEDS PAIRING', 'rose']
]

const badges = (): string =>
  BADGES.map(
    ([state, label, tone], i) =>
      `<span class="chip${tone === '' ? '' : ` ${tone}`}" data-badge="${state}"${i === 0 ? '' : ' hidden'}>${label}</span>`
  ).join('')

/** Only the addresses; the signature travels too, so a device can re-check it. */
const reachOf = (desktop: V2Desktop): string =>
  JSON.stringify(desktop.reach === null || desktop.reach === undefined ? { lan: [], tailnet: null, relay: false } : desktop.reach)

function desktopRow(desktop: V2Desktop): string {
  const workspaces =
    desktop.workspaces.length === 0
      ? 'No workspaces registered yet'
      : desktop.workspaces.map((w) => esc(w.name)).join(' · ')
  const id = esc(desktop.deviceId)
  return `<li class="desktop" data-desktop="${id}" data-reach="${esc(reachOf(desktop))}">
<span class="chip">Mac</span>
<span><b>${esc(desktop.name)}</b><br><span class="meta">${workspaces}</span>
<span class="meta" data-pair-note hidden>${PAIR_SENTENCE}</span></span>
<span class="reach-actions">${badges()}
<button class="btn sm primary" data-open-desktop="${id}" hidden>OPEN</button>
<button class="btn sm" data-scan="${id}" hidden>SCAN QR</button>
<button class="btn sm" data-type-key="${id}" hidden>TYPE KEY</button>
<button class="btn sm" data-forget-pair="${id}" hidden>FORGET KEY</button></span></li>`
}

/**
 * The DESKTOPS section of /me. Empty is a sentence rather than an empty list:
 * a person who has not claimed the username in the app yet should read why
 * there is nothing here, not wonder whether the page is broken.
 */
export function desktopsSection(desktops: readonly V2Desktop[]): string {
  const rows =
    desktops.length === 0
      ? `<li><span class="meta">No desktop has registered its workspaces yet. Claim this username in the app and they appear here.</span></li>`
      : desktops.map(desktopRow).join('')
  return `<h2 style="margin-top:30px">Desktops</h2>
<p class="meta">Names, ids and addresses only — cookrew.dev never holds what is on a canvas. The badge is the path this browser found just now: LAN, then your tailnet, then the relay.</p>
<p class="meta" id="reach-refused" hidden>${WRONG_KEY_SENTENCE}</p>
<ul class="doors me-list" id="me-desktops">${rows}</ul>`
}

/** Every origin the page is allowed to probe, for this reader's CSP and no more. */
export function reachOrigins(desktops: readonly V2Desktop[]): string[] {
  const found = new Set<string>()
  for (const desktop of desktops) {
    for (const address of desktop.reach?.lan ?? []) found.add(address.url)
    if (desktop.reach?.tailnet) found.add(desktop.reach.tailnet.url)
  }
  return [...found]
}
