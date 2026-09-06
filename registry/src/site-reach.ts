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
 * A REFUSAL BELONGS TO A ROW. A desktop that would not take the six
 * characters sends the reader back naming itself, and the sentence goes under
 * THAT Mac, beside the field that fixes it — a line at the top of the page
 * makes a reader with three Macs guess which one it is about.
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
/**
 * What a desktop says when the link named the MAC where the phone should be.
 * A canvas token names both ends, so a link built with the wrong end is
 * refused before the key is even looked at — and the reader needs to know it
 * was the link and not their key, or they will retype a key that was fine.
 */
export const WRONG_DEVICE_SENTENCE = 'That link named the Mac, not the phone — open it again from cookrew.dev.'
/** What the six-character field says when what was typed is not six characters. */
export const KEY_SHAPE_SENTENCE = 'Six characters, letters and digits — the ones shown beside the QR.'

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
<button class="btn sm primary" data-open-desktop="${id}" hidden disabled>OPEN</button>
<button class="btn sm" data-scan="${id}" hidden>SCAN QR</button>
<button class="btn sm" data-type-key="${id}" hidden>TYPE KEY</button>
<button class="btn sm" data-forget-pair="${id}" hidden>FORGET KEY</button>
<span class="pair-key" data-key-form="${id}" hidden><input class="pair-input" data-key-input="${id}" maxlength="6" size="6" spellcheck="false" autocomplete="one-time-code" autocapitalize="characters" placeholder="7KQ2M8" aria-label="The six characters beside the QR on the Mac"><button class="btn sm primary" data-key-link="${id}">LINK</button></span></span>
<span class="meta" data-key-note hidden>${KEY_SHAPE_SENTENCE}</span>
<span class="meta" data-refused-key hidden>${WRONG_KEY_SENTENCE}</span>
<span class="meta" data-refused-device hidden>${WRONG_DEVICE_SENTENCE}</span></li>`
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
<p class="meta" id="reach-refused-device" hidden>${WRONG_DEVICE_SENTENCE}</p>
<!-- The page-level pair above is the FALLBACK, for a refusal that named no
     desktop. A refusal that named one belongs under that row, beside the
     field that fixes it. -->
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
