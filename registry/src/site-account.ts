import { DELETE_ACCOUNT_KEEPS, DELETE_ACCOUNT_TAKES, DELETE_ACCOUNT_WARNING } from '../../src/shared/account-delete'
import { machineCopy } from '../../src/shared/machine-words'
import { WEB_STEP_UP_ACTS } from '../../src/shared/auth-site'
import { webCopy } from './v3-copy'
import { day, esc, page, type Page } from './site-shell'
import { desktopsSection } from './site-reach'
import { machinesConsole, type ConsoleMachine } from './site-machines'
import type { V2Account, V2Device } from './v2-accounts'

/**
 * THE ACCOUNT ON cookrew.dev — the sign-in sheet (W1) and /me (W3).
 *
 * Both are rendered here rather than assembled by a script, for the same
 * reason every other page on this site is: the markup a reader gets is the
 * markup we wrote, and the CSP forbids an inline script to build it. The
 * script's whole job is the four verbs — check a name, sign in, revoke a
 * device, sign out.
 *
 * PHASE 4 FILLED THE SECURITY SECTION. The passkey and authenticator rows are
 * real now: they carry the verbs factors.js performs, and the account's own
 * keys are listed by the name their owner gave them. Requests to sign in from
 * another device appear under them, polled, with APPROVE / DENY / NOT ME.
 */

const KIND_LABEL: Record<V2Device['kind'], string> = {
  desktop: 'Desktop',
  phone: 'Phone',
  browser: 'Browser',
  watch: 'Watch',
  // The key this name held before it had a password (phase 6). Listed like
  // any other device, and revocable like one: that is how the old world ends.
  legacy: 'Key'
}

const initials = (account: V2Account): string =>
  (account.displayName.trim() || account.username).slice(0, 2).toUpperCase()

function deviceRow(device: V2Device, current: boolean): string {
  const seen = current ? 'This device' : `Last seen ${day(device.lastSeenAt)}`
  const action = current
    ? `<button class="btn sm" data-revoke="${esc(device.id)}" data-current="1">Sign out here</button>`
    : `<button class="btn sm danger" data-revoke="${esc(device.id)}">Revoke</button>`
  return `<li><span class="chip">${esc(KIND_LABEL[device.kind])}</span>
<span><b>${esc(device.name)}</b><br><span class="meta">Attached ${esc(day(device.addedAt))} · ${esc(seen)}</span></span>
${action}</li>`
}

/** One row per enrolled passkey — a factor, so removing the last is allowed. */
function passkeyRows(passkeys: readonly { id: string; name: string; addedAt: number }[]): string {
  return passkeys
    .map(
      (p) => `<li><span class="chip">Passkey</span>
<span><b>${esc(p.name)}</b><br><span class="meta">Added ${esc(day(p.addedAt))}</span></span>
<button class="btn sm danger" data-drop-passkey="${esc(p.id)}">Remove</button></li>`
    )
    .join('')
}

/**
 * ONE ROW, TWO STATES — and the words for both live here.
 *
 * factors.js flips this row in place the moment a code is verified, rather
 * than reloading the page under somebody who has just typed six digits. So
 * the sentences it writes are the sentences below, exported for it to use by
 * id: two copies of a sentence become two different sentences.
 */
export const TOTP_ACTIVE_NOTE =
  'Six digits, every thirty seconds. Asked for on a device this account has not seen.'
export const TOTP_ADD_NOTE =
  'A six-digit code from an app on your phone. Scan a QR, or type the secret.'

function authenticatorRow(active: boolean): string {
  return active
    ? `<li id="me-totp-row"><span class="chip">Factor</span><span><b>Authenticator app</b><br><span class="meta" id="me-totp-note">${TOTP_ACTIVE_NOTE}</span></span><button class="btn sm danger" data-drop-totp>Remove</button></li>`
    : `<li id="me-totp-row"><span class="chip">Factor</span><span><b>Authenticator app</b><br><span class="meta" id="me-totp-note">${TOTP_ADD_NOTE}</span></span><button class="btn sm" data-add-totp>Add</button></li>`
}

/**
 * /me — WHO YOU ARE, WHAT IS ATTACHED, AND HOW TO TAKE IT BACK.
 *
 * Rendered for one reader and never cached (cache: 0, private). Signed out it
 * is a 401 that is still a page: somebody following a link deserves a sentence
 * and a way in, not a JSON body.
 */
/** What phase 4 knows about an account, for the Security rows. */
export interface FactorSummary {
  passkeys: readonly { id: string; name: string; addedAt: number }[]
  totp: boolean
}

/** The site cannot know what a desktop runs, so /me says machine for all of them. */
const meCopy = (...args: Parameters<typeof webCopy>): string => machineCopy(webCopy(...args), 'any')

const PASSWORD_ROW =
  '<li id="me-password-row"><span class="chip">Password</span><span><b>Your password</b><br><span class="meta" id="me-password-note">At least 12 characters. It goes only to this site.</span></span><button class="btn sm" data-password>Change</button></li>'
/** Owner's ruling 3: a provider-only account sets an account password to enter a machine without a passkey. */
const FIRST_PASSWORD_ROW =
  '<li id="me-password-row"><span class="chip">Password</span><span><b>No password yet</b><br><span class="meta" id="me-password-note">You sign in with your provider. Set a password to enter your machines with it — or add a passkey below.</span></span><button class="btn sm" data-password data-first>Set</button></li>'

/**
 * THE NAME, AND THE PASSWORD WHEN THERE IS ONE. An account with no password
 * proves it on auth.cookrew.dev (step-up.js) and comes back here to press the
 * button again; it used to be sent to the desktop app for something the web
 * can do.
 */
const deleteForm = (username: string, passwordless: boolean): string =>
  `<p class="row"><input id="me-delete-name" autocomplete="off" spellcheck="false" placeholder="Type ${esc(username)} to confirm" aria-label="Type your username to confirm">
${passwordless ? '' : '<input id="me-delete-password" type="password" autocomplete="current-password" placeholder="Your password" aria-label="Your password">\n'}<button class="btn" data-delete-account>Delete my account</button></p>
${passwordless ? '<p class="meta">Cookrew asks you to confirm it is you — with your passkey, your sign-in provider or a code — then brings you back here to finish.</p>\n' : ''}<p class="meta" id="me-delete-note" role="status" hidden></p>`

export function mePage(
  input: {
    account: V2Account
    currentDeviceId: string
    factors?: FactorSummary
    /** The account's machines with their standing (v2-fleet.ts · standing); the console draws them. */
    machines?: readonly ConsoleMachine[]
    now?: number
    /**
     * `devices` (plain /me): with a pass held, machines.js goes on into the Devices view.
     * `account` (/me/account, and any /me that carries a return or a section): this page stays.
     */
    view?: 'devices' | 'account'
    /**
     * How much longer this session counts as just proved, in ms (v2-session-age.ts · freshlyVerified): a
     * sensitive act needs no second proof. machines.js opens no machine's page by itself before then (security review M1).
     */
    freshForMs?: number
  } | null,
  /**
   * ON THE AUTH HOST (0.6.0), where this page lives when the registry splits
   * its hosts: the account, its devices and its security, and nothing of any
   * machine. The machines are the console's, on another origin.
   */
  standalone?: { site: string; console: string | null; home: string }
): Page {
  if (input === null) {
    return page(
      {
        title: 'Your account — Cookrew',
        kind: 'app',
        cache: 0,
        status: 401,
        noindex: true,
        scripts: ['device-id.js', 'site.js'],
        ...(standalone ? { standalone } : {})
      },
      `<div class="wrap" style="padding-top:44px"><h1>Your account</h1>
<p class="lede">${esc(meCopy('avatar.no-account'))}</p>
<p class="row"><button class="btn primary lg" data-signin>Sign in or register</button>${standalone ? '' : '<a class="btn lg" href="/market">Marketplace</a>'}</p></div>`
    )
  }
  const { account, currentDeviceId } = input
  const factors: FactorSummary = input.factors ?? { passkeys: [], totp: false }
  const face =
    account.avatar === null
      ? `<span class="avatar">${esc(initials(account))}</span>`
      : `<img class="avatar" src="${esc(account.avatar)}" alt="" width="56" height="56">`
  const devices = [...account.devices]
    .sort((a, b) => (a.id === currentDeviceId ? -1 : b.id === currentDeviceId ? 1 : b.lastSeenAt - a.lastSeenAt))
    .map((d) => deviceRow(d, d.id === currentDeviceId))
    .join('')
  const codes = account.recovery.length
  // The machines' part of this page: drawn on the single-host site, never on the auth host.
  const MACHINES = `${input.view === 'account' ? '<p class="row"><a class="btn sm" href="/me">‹ Your machines</a></p>' : ''}
<!-- THE DOOR TO THE DEVICES VIEW (owner 2026-11-10): the machines first; account and security below, on this page. -->
${machinesConsole(account.username, input.machines ?? account.desktops.map((d) => ({ id: d.deviceId, name: d.name, online: false, lastSeenAt: d.updatedAt ?? null, profile: d.profile ?? null })), input.now ?? Date.now())}`
  const REACH = `<!-- The machines' addresses and the Wi-Fi ask (M5): kept, folded under the console. -->
<details style="margin-top:30px" id="me-reach"><summary>Machine addresses and Wi-Fi</summary>
${desktopsSection(account.username, account.desktops)}
</details>`
  return page(
    {
      title: `@${account.username} — Cookrew`,
      kind: 'app',
      account: account.username,
      cache: 0,
      noindex: true,
      // device-seal.js before reach.js: M5's answer arrives sealed to this
      // device, and the opener has to be on the page by the time it lands.
      // step-up.js before site.js: the sensitive acts both scripts own prove
      // themselves through it, and it finishes them on the way back.
      // machines.js after site.js: it signs at each machine's door with this browser's key.
      scripts: standalone ? ['device-id.js', 'step-up.js', 'site.js'] : ['device-id.js', 'step-up.js', 'site.js', 'device-seal.js', 'reach.js', 'machines.js'],
      ...(standalone ? { standalone } : {})
    },
    `<div class="wrap" style="padding-top:44px" id="me"${input.view === 'account' ? '' : ' data-go="devices"'}${input.freshForMs !== undefined ? ` data-fresh-ms="${Math.round(input.freshForMs)}"` : ''} data-username="${esc(account.username)}" data-has-password="${account.passwordless === true ? '0' : '1'}" data-step-up-acts="${WEB_STEP_UP_ACTS.join(' ')}">
<div class="me-head">${face}<div><h1 style="margin:0">@${esc(account.username)}</h1>
<p class="meta" id="me-display">${esc(account.displayName || 'No display name yet')} · member since ${esc(day(account.claimedAt))}</p></div>
<span class="sp" style="flex:1"></span>
<button class="btn" data-edit-name>Edit</button>
<button class="btn" data-signout>Sign out</button></div>

${standalone ? (standalone.console === null ? '' : `<p class="row"><a class="btn sm" href="${esc(standalone.console)}/">‹ Your machines, in the console</a></p>`) : MACHINES}

<!-- W5 · REQUESTS SITS ABOVE DEVICES, and the whole section hides itself when
     the queue is empty. It is above because it is the only part of this page
     that is WAITING for the reader: devices and security are things to look
     at, a request is a thing to answer. factors.js unhides it the moment the
     poll returns a row and hides it again when the last one is answered, so
     a person with nothing waiting is not given a heading that says so. -->
<section id="me-requests" hidden>
<h2 style="margin-top:30px">Requests</h2>
<p class="meta">${esc(meCopy('w5.requests-footer', { handle: account.username }))}</p>
<ul class="doors me-list" id="me-approvals" data-join-row="${esc(meCopy('w5.join-row'))}"
 data-seat-row="${esc(meCopy('d11.seat-row', { handle: '{handle}', team: '{team}' }))}"
 data-wifi-row="${esc(meCopy('w5.reach-elsewhere', { device: '{device}' }))}"></ul>
</section>

${standalone ? '' : REACH}

<h2 style="margin-top:30px" id="me-devices-heading">Devices</h2>
<p class="meta">Every device attached to @${esc(account.username)}. ${esc(meCopy('d12.revoke', { device: 'device' }))} ${esc(meCopy('d12.last-device', { handle: account.username }))}</p>
<ul class="doors me-list" id="me-devices">${devices}</ul>
<!-- W5 · the two ADD buttons. Both mint the same join code; the words differ
     because what a person is holding differs, and "add a phone" is the
     sentence somebody standing with a phone is looking for. -->
<p class="row"><button class="btn" data-add-device="desktop">Add a machine</button>
${standalone ? '' : '<button class="btn" data-add-device="phone">Add a phone</button>'}</p>
<div class="totp-panel" id="me-join-code" data-add-lede="${esc(meCopy('w5.add-lede'))}" hidden></div>

<h2 style="margin-top:30px" id="security">Security</h2>
<ul class="doors me-list" id="me-security">
${account.passwordless === true ? FIRST_PASSWORD_ROW : PASSWORD_ROW}
${passkeyRows(factors.passkeys)}
<li><span class="chip">Factor</span><span><b>Passkey (Touch ID / Face ID)</b><br><span class="meta" data-passkey-note>Recommended. It lives on this device and cannot be typed by anyone else.</span></span><button class="btn sm" data-add-passkey>Add</button></li>
${authenticatorRow(factors.totp)}
<li><span class="chip">Rescue</span><span><b>Recovery codes</b><br><span class="meta" id="me-codes-note">${codes === 0 ? 'None saved. Each code opens the account once.' : `${codes} unused. Showing a new set replaces them.`}</span></span><button class="btn sm" data-recovery>Show</button></li>
</ul>
<div class="totp-panel" id="me-password" hidden></div>
<pre class="cmd" id="me-codes" hidden></pre>
<div class="totp-panel" id="me-totp" hidden></div>

<details style="margin-top:30px" id="me-delete"><summary>Delete account</summary>
<p class="lede">${esc(DELETE_ACCOUNT_WARNING)}</p>
<p class="meta">This deletes:</p><ul>${DELETE_ACCOUNT_TAKES.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
<p class="meta">This stays:</p><ul>${DELETE_ACCOUNT_KEEPS.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
${deleteForm(account.username, account.passwordless === true)}
</details>
</div>`
  )
}

/**
 * M4 · /join — the page a join-code QR points a phone at.
 *
 * THE CODE IS IN THE FRAGMENT AND NEVER REACHES THIS FUNCTION. That is the
 * point of putting it there: the server renders one page for every code, so
 * there is nothing here to log, nothing to correlate, and no way for this
 * route to become an oracle for which codes exist. The script reads the
 * fragment, scrubs it out of the address bar, and spends it on one button.
 *
 * IT DOES NOT NAME THE ACCOUNT, and the design's mock does. Naming it would
 * need a "what account is this code for" route, and that route is a checker:
 * somebody guessing codes would learn which guesses were live without ever
 * spending one. The account's name is on the other side of the button —
 * POST /v2/join answers with it — so the cost of not showing it first is one
 * screen, and the cost of showing it is a way to hunt for live codes.
 *
 * NO SESSION IS NEEDED. A phone arriving here has no account yet; that is the
 * whole situation. The page is an app page because it needs the script, and
 * the account sheet travels with it so "sign in with your password instead"
 * is one tap rather than another address.
 */
export function joinPage(): Page {
  return page(
    {
      title: 'Join an account — Cookrew',
      kind: 'app',
      cache: 0,
      noindex: true,
      scripts: ['device-id.js', 'site.js']
    },
    `<div class="wrap" style="padding-top:44px" id="join-card">
<h1>Join on this device</h1>
<p class="lede" id="join-lede">${esc(meCopy('m4.join-lede'))}</p>
<p class="meta" id="join-message" role="status"></p>
<p class="row"><button class="btn primary lg" id="join-go" hidden>Join</button>
<button class="btn lg" data-signin>${esc(meCopy('m4.join-instead'))}</button></p>
<p class="meta" id="join-none" hidden>${esc(meCopy('m4.no-code'))}</p></div>`
  )
}
