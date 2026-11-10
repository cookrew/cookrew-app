import type { MachineProfile } from '../../src/shared/fleet'
import { machineCaption } from '../../src/shared/machine-shape'
import { esc } from './site-shell'
import { relayPrefix } from './site-reach'

/**
 * cookrew.dev/me: THE WAY INTO THE DEVICES VIEW (owner 2026-11-10: "the /me web
 * page must be the desktop Devices view, the same page").
 *
 * The Devices view is the app's own, served by one of the account's machines
 * through the relay; machines.js goes there as soon as this browser holds the
 * account's twelve-hour pass, and that page reads every other machine with this
 * browser's own key for each (renderer relay-machine-call.ts). What is here is
 * only the door: the gate, and the machines as cookrew.dev itself knows them.
 *
 * NOTHING FROM INSIDE A MACHINE BEFORE ITS GATE (owner: hide workspace names
 * too): the name, the platform it reported, and whether it holds its line. An
 * offline machine opens nothing, and says when it was last seen.
 */

export interface ConsoleMachine {
  readonly id: string
  readonly name: string
  readonly online: boolean
  readonly lastSeenAt: number | null
  readonly profile: MachineProfile | null
  /** Known to cookrew.dev, never written on the console: inside a machine, so behind its gate. */
  readonly workspaces?: readonly string[]
}

/** "3 h ago", "2 days ago": coarse on purpose. */
export function sinceWords(at: number | null, now: number): string {
  if (at === null) return 'not seen yet'
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function row(username: string, machine: ConsoleMachine, now: number): string {
  const status = machine.online ? '<span class="ms-status on">● online</span>' : `<span class="ms-status">○ last seen ${esc(sinceWords(machine.lastSeenAt, now))}</span>`
  const words = `<span class="ms-who"><b class="ms-name">${esc(machine.name)}</b><span class="ms-sub">${esc(machineCaption(machine.profile))}</span></span>${status}`
  const id = esc(machine.id)
  return machine.online
    ? `<li class="ms-machine" data-machine="${id}" data-online="1">${words}<a class="btn sm" href="${esc(relayPrefix(username, machine.id))}" data-open-machine>Open</a></li>`
    : `<li class="ms-machine off" data-machine="${id}" data-online="0" aria-disabled="true">${words}</li>`
}

/** The door: the gate (shown by machines.js when this browser holds no pass), then every machine. */
export function machinesConsole(username: string, machines: readonly ConsoleMachine[], now: number): string {
  const ordered = [...machines].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  const list =
    ordered.length === 0
      ? '<p class="meta">No machine has signed in to this account yet. Sign in to Cookrew on a computer and it appears here.</p>'
      : `<ul class="doors me-list ms-list">${ordered.map((machine) => row(username, machine, now)).join('')}</ul>`
  return `<section id="me-console" aria-label="Your machines">
<h2 style="margin-top:22px">Your machines</h2>
<div class="ms-gate" id="me-gate" hidden><span class="meta">Prove it’s you once to open your machines here: one password or passkey, for all of them, for 12 hours.</span>
<span class="row"><input id="me-gate-password" type="password" autocomplete="current-password" placeholder="Account password" aria-label="Account password" hidden>
<button class="btn sm primary" data-gate>Password or passkey</button></span>
<span class="meta" id="me-gate-note" role="status" hidden></span></div>
<p class="meta" id="me-opening" role="status" hidden>Opening your machines…</p>
<div id="me-machines" data-username="${esc(username)}">${list}</div>
</section>`
}
