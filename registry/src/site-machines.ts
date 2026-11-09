import type { MachineProfile } from '../../src/shared/fleet'
import { machineCaption, machineShape, machineSvg } from '../../src/shared/machine-shape'
import { esc } from './site-shell'
import { relayPrefix } from './site-reach'

/**
 * cookrew.dev/me AS THE CONSOLE (owner, 2026-11-10).
 *
 * The page opens on the account's machines, each drawn as what it is
 * (shared/machine-shape.ts): a MacBook, a Linux tower, a server in a cloud.
 * Click one to go into it — its own page, through the relay.
 *
 * NOTHING FROM INSIDE A MACHINE BEFORE ITS GATE (owner: hide workspace names
 * too). The server writes only what cookrew.dev itself knows: the name, the
 * platform the machine reported, and whether it holds its line. Each drawing's
 * screen is an empty group; machines.js fills it from the machine's own summary
 * after the reader has proved it is them (the twelve-hour pass), and not before.
 *
 * An offline machine opens nothing: no link, and a line that says when it was
 * last seen, so nobody is sent to a page that cannot answer.
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

function tile(username: string, machine: ConsoleMachine, now: number): string {
  const shape = machineShape(machine.profile)
  const drawing = machineSvg(shape, shape === 'cloud' ? (machine.profile?.vendor ?? machine.profile?.label ?? null) : null)
  const status = machine.online
    ? '<span class="ms-status on">● online</span><span class="ms-need" data-need hidden></span>'
    : `<span class="ms-status">○ last seen ${esc(sinceWords(machine.lastSeenAt, now))}</span>`
  const inner = `${drawing}<b class="ms-name">${esc(machine.name)}</b><span class="ms-sub">${esc(machineCaption(machine.profile))}</span>${status}`
  const id = esc(machine.id)
  return machine.online
    ? `<a class="ms-machine" href="${esc(relayPrefix(username, machine.id))}" data-machine="${id}" data-online="1">${inner}</a>`
    : `<div class="ms-machine off" data-machine="${id}" data-online="0" aria-disabled="true">${inner}</div>`
}

/** The console: the gate (shown by machines.js when this browser holds no pass), then every machine. */
export function machinesConsole(username: string, machines: readonly ConsoleMachine[], now: number): string {
  const ordered = [...machines].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  const grid =
    ordered.length === 0
      ? '<p class="meta">No machine has signed in to this account yet. Sign in to Cookrew on a computer and it appears here.</p>'
      : ordered.map((machine) => tile(username, machine, now)).join('')
  return `<section id="me-console" aria-label="Your machines">
<h2 style="margin-top:22px">Your machines</h2>
<div class="ms-gate" id="me-gate" hidden><span class="meta">Prove it’s you to see inside them: once, for all of them, for 12 hours.</span>
<span class="row"><input id="me-gate-password" type="password" autocomplete="current-password" placeholder="Account password" aria-label="Account password" hidden>
<button class="btn sm primary" data-gate>Password or passkey</button></span>
<span class="meta" id="me-gate-note" role="status" hidden></span></div>
<div class="ms-grid" id="me-machines" data-username="${esc(username)}">${grid}</div>
</section>`
}
