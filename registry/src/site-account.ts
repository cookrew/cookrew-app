import { day, esc, page, type Page } from './site-shell'
import { desktopsSection, reachOrigins } from './site-reach'
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

const KIND_LABEL: Record<V2Device['kind'], string> = { desktop: 'Desktop', phone: 'Phone', browser: 'Browser' }

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

function authenticatorRow(active: boolean): string {
  return active
    ? `<li><span class="chip">Factor</span><span><b>Authenticator app</b><br><span class="meta">Six digits, every thirty seconds. Asked for on a device this account has not seen.</span></span><button class="btn sm danger" data-drop-totp>Remove</button></li>`
    : `<li><span class="chip">Factor</span><span><b>Authenticator app</b><br><span class="meta">A six-digit code from an app on your phone. The secret is shown once, as text.</span></span><button class="btn sm" data-add-totp>Add</button></li>`
}

function desktopRow(name: string, workspaces: readonly { id: string; name: string }[]): string {
  const list = workspaces.length === 0 ? 'No workspaces registered yet' : workspaces.map((w) => esc(w.name)).join(' · ')
  return `<li><span class="chip">Mac</span><span><b>${esc(name)}</b><br><span class="meta">${list}</span></span>
<span class="chip">Reachable</span></li>`
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

export function mePage(
  input: { account: V2Account; currentDeviceId: string; factors?: FactorSummary } | null
): Page {
  if (input === null) {
    return page(
      {
        title: 'Your account — Cookrew',
        kind: 'app',
        cache: 0,
        status: 401,
        noindex: true,
        scripts: ['device-id.js', 'site.js']
      },
      `<div class="wrap" style="padding-top:44px"><h1>Your account</h1>
<p class="lede">A seat is yours, not a browser's. Sign in so it follows you.</p>
<p class="row"><button class="btn primary lg" data-signin>Sign in or register</button><a class="btn lg" href="/market">Marketplace</a></p></div>`
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
  return page(
    {
      title: `@${account.username} — Cookrew`,
      kind: 'app',
      cache: 0,
      noindex: true,
      scripts: ['device-id.js', 'site.js', 'reach.js'],
      connect: reachOrigins(account.desktops)
    },
    `<div class="wrap" style="padding-top:44px" id="me" data-username="${esc(account.username)}">
<div class="me-head">${face}<div><h1 style="margin:0">@${esc(account.username)}</h1>
<p class="meta" id="me-display">${esc(account.displayName || 'No display name yet')} · member since ${esc(day(account.claimedAt))}</p></div>
<span class="sp" style="flex:1"></span>
<button class="btn" data-edit-name>Edit</button>
<button class="btn" data-signout>Sign out</button></div>

<h2 style="margin-top:30px">Devices</h2>
<p class="meta">Every device attached to @${esc(account.username)}. Revoking one stops it opening this account within a minute; it keeps working on its own Wi-Fi until it is paired again. The last device cannot be revoked.</p>
<ul class="doors me-list" id="me-devices">${devices}</ul>

<h2 style="margin-top:30px">Security</h2>
<ul class="doors me-list" id="me-security">
<li><span class="chip">Password</span><span><b>Your password</b><br><span class="meta">At least 12 characters. It goes only to cookrew.dev.</span></span><button class="btn sm" data-password>Change</button></li>
${passkeyRows(factors.passkeys)}
<li><span class="chip">Factor</span><span><b>Passkey (Touch ID / Face ID)</b><br><span class="meta" data-passkey-note>Recommended. It lives on this device and cannot be typed by anyone else.</span></span><button class="btn sm" data-add-passkey>Add</button></li>
${authenticatorRow(factors.totp)}
<li><span class="chip">Rescue</span><span><b>Recovery codes</b><br><span class="meta" id="me-codes-note">${codes === 0 ? 'None saved. Each code opens the account once.' : `${codes} unused. Showing a new set replaces them.`}</span></span><button class="btn sm" data-recovery>Show</button></li>
</ul>
<pre class="cmd" id="me-codes" hidden></pre>
<pre class="cmd" id="me-totp" hidden></pre>

<h2 style="margin-top:30px">Requests</h2>
<p class="meta">A device asking to sign in as @${esc(account.username)}. Approve attaches it and names it in Devices; deny does nothing else; “not me” signs every other device out and locks the password until you change it.</p>
<ul class="doors me-list" id="me-approvals"></ul>

${desktopsSection(account.desktops)}
</div>`
  )
}
