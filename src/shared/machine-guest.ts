/**
 * ANOTHER MACHINE OF THE ACCOUNT, DRAWN ON THIS DESKTOP AS THE CONSOLE DRAWS IT
 * (owner 2026-11-25: "the same rendering as that machine in the console, so its
 * agents are worked exactly as this machine's are").
 *
 * The console shows a machine as the whole app, the one a phone has always
 * seen of its Mac, against that machine (console/ConsoleMachine.tsx). The
 * desktop now does the same, in a <webview> of its own (the GUEST): this app's
 * own renderer page, loaded at `cookrew-machine://<machine id>/`, booted as a
 * console page with that one machine in scope (renderer guest/guest-wiring.ts).
 *
 *   the page and its assets   served by main from this app's own build
 *   `/api/m…` on that origin  the relay path, carried by main down the account's
 *                             relay with the account session added there
 *                             (main/machine-guest.ts): the session never
 *                             reaches a renderer
 *   the machine's own key     the key this desktop holds for it (machine-keys),
 *                             handed to the guest in its page, as the console's
 *                             door hands a browser its key
 *
 * The guest and the window that holds it speak in two small messages, both
 * checked on arrival: the guest REPORTS where it stands (so the window's title
 * line can name that machine's workspace and agent) and when it is left; the
 * window COMMANDS its title line's steps. Pure: shared by main, the window and
 * the guest.
 */
import { isMachineId } from './machine-relay'

/** The scheme the guest page is served at, one origin per machine. */
export const MACHINE_GUEST_SCHEME = 'cookrew-machine'

/**
 * The guest's session. In memory on purpose (no `persist:`): the machine's key
 * sits in its storage, and must not outlive the app on disk.
 */
export const MACHINE_GUEST_PARTITION = 'cookrew-machine'

/**
 * The guest's page: this app's own renderer page (src/renderer/index.html),
 * which boots as the guest when main has written the guest's boot line into it
 * (renderer guest/guest-wiring.ts).
 */
export const MACHINE_GUEST_PAGE = '/'

/** Guest → window, over the webview's own channel (ipcRenderer.sendToHost). */
export const GUEST_REPORT_CHANNEL = 'machine-guest'
/** Window → guest (webview.send). */
export const GUEST_COMMAND_CHANNEL = 'machine-guest:command'

export type GuestSide = 'agents' | 'items'

/** Where the guest opens: that machine's workspaces, a workspace's agents or artifacts, an agent, an artifact. */
export interface GuestEntry {
  readonly workspace: string | null
  readonly agent: string | null
  readonly item: string | null
  readonly side: GuestSide
}

export const GUEST_AT_WORKSPACES: GuestEntry = { workspace: null, agent: null, item: null, side: 'agents' }

/** A workspace's, an agent's or an artifact's id as an app mints it: plain, nothing to decode. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/
const plain = (value: string | null | undefined): string | null => (typeof value === 'string' && PLAIN_ID.test(value) ? value : null)

/** Only what holds together: an agent or an artifact is always in a workspace. */
export function guestEntry(asked: Partial<GuestEntry>): GuestEntry {
  const workspace = plain(asked.workspace)
  if (workspace === null) return GUEST_AT_WORKSPACES
  const agent = plain(asked.agent)
  const item = agent === null ? plain(asked.item) : null
  const side: GuestSide = item !== null || (agent === null && asked.side === 'items') ? 'items' : 'agents'
  return { workspace, agent, item, side }
}

/** The guest's address for a machine, opened where `entry` says. Null for anything that is not a machine id. */
export function machineGuestUrl(machineId: string, entry: GuestEntry = GUEST_AT_WORKSPACES, theme: string | null = null): string | null {
  const id = machineId.toLowerCase()
  if (!isMachineId(id)) return null
  const at = guestEntry(entry)
  const query = new URLSearchParams()
  if (at.workspace !== null) query.set('w', at.workspace)
  if (at.agent !== null) query.set('a', at.agent)
  if (at.item !== null) query.set('i', at.item)
  if (at.side === 'items' && at.item === null) query.set('side', 'items')
  if (theme !== null && PLAIN_ID.test(theme)) query.set('theme', theme)
  const search = query.toString()
  return `${MACHINE_GUEST_SCHEME}://${id}${MACHINE_GUEST_PAGE}${search ? `?${search}` : ''}`
}

/** The entry a guest page was opened with, read from its own address. */
export function guestEntryOf(search: string): GuestEntry {
  const query = new URLSearchParams(search)
  return guestEntry({ workspace: query.get('w'), agent: query.get('a'), item: query.get('i'), side: query.get('side') === 'items' ? 'items' : 'agents' })
}

/** The theme the window wore when it opened the guest, if it named one. */
export function guestThemeOf(search: string): string | null {
  return plain(new URLSearchParams(search).get('theme'))
}

/** The machine a guest URL is for: its host, a machine id. Null for any other URL. */
export function guestMachineOf(url: string): string | null {
  const found = new RegExp(`^${MACHINE_GUEST_SCHEME}://([^/?#]+)(?:[/?#]|$)`, 'i').exec(url)
  const id = found?.[1]?.toLowerCase() ?? null
  return id !== null && isMachineId(id) ? id : null
}

/** Why a guest let go of its machine. */
export type GuestLeave = 'devices' | 'no-key' | 'key-refused' | 'signed-out'
const LEAVES: readonly GuestLeave[] = ['devices', 'no-key', 'key-refused', 'signed-out']

/** What the guest says to the window. `route` names, never ids: it is drawn on the title line as it stands. */
export type GuestReport =
  | { readonly kind: 'route'; readonly workspace: string | null; readonly agent: string | null }
  | { readonly kind: 'leave'; readonly why: GuestLeave }

/** What the window asks of the guest: its title line's steps, and Esc / ⌘W from outside it. */
export type GuestCommand = { readonly kind: 'device' } | { readonly kind: 'workspace' } | { readonly kind: 'back' }
const COMMANDS: readonly GuestCommand['kind'][] = ['device', 'workspace', 'back']

/** A name to draw, cut to a title line's length; null for nothing usable. */
const name = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 120) : null)

export function parseGuestReport(value: unknown): GuestReport | null {
  if (typeof value !== 'object' || value === null) return null
  const said = value as { kind?: unknown; workspace?: unknown; agent?: unknown; why?: unknown }
  if (said.kind === 'route') return { kind: 'route', workspace: name(said.workspace), agent: name(said.agent) }
  if (said.kind === 'leave' && LEAVES.includes(said.why as GuestLeave)) return { kind: 'leave', why: said.why as GuestLeave }
  return null
}

export function parseGuestCommand(value: unknown): GuestCommand | null {
  if (typeof value !== 'object' || value === null) return null
  const kind = (value as { kind?: unknown }).kind
  return COMMANDS.includes(kind as GuestCommand['kind']) ? { kind: kind as GuestCommand['kind'] } : null
}

/** What main hands the guest in its page: the machine, and the key this desktop holds for it (null: none yet). */
export interface GuestBoot {
  readonly machine: string
  readonly key: string | null
}

export function parseGuestBoot(value: unknown): GuestBoot | null {
  if (typeof value !== 'object' || value === null) return null
  const said = value as { machine?: unknown; key?: unknown }
  if (!isMachineId(said.machine)) return null
  return { machine: said.machine, key: typeof said.key === 'string' && said.key !== '' ? said.key : null }
}
