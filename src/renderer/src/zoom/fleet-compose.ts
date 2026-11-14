/**
 * THE FLEET AS THE NAVIGATOR DRAWS IT, composed from what was read: one
 * machine's own feed (a snapshot folded from deltas), the account's list of
 * machines from the registry, and each other machine's own summary. Pure: no
 * store, no api, no window. The desktop's and a machine page's fleet store
 * (use-zoom-fleet.ts) and the console's Devices level (console/) both draw
 * from this, so a machine reads the same wherever it is drawn.
 */
import type { WorkspaceList } from '../../../shared/model'
import type { FleetAgent, FleetAttachment, FleetSnapshot, FleetWorkspace, MachineDisplay, MachineProfile, WorkspaceTrait } from '../../../shared/fleet'
import type { AccountMachine, AccountMachines } from '../../../shared/zoom-fleet'

/** How many of a workspace's pages its tile's deck shows. */
export const DECK_SHOWN = 3

export type ZoomFleetAgent = FleetAgent
export type ZoomFleetAttachment = FleetAttachment

export interface ZoomCounts {
  agents: number
  notes: number
  browsers: number
  /** Agents waiting on the owner. */
  waiting: number
  /** Agents thinking right now. */
  working: number
}

export interface ZoomFleetWorkspace {
  id: string
  name: string
  icon: string | null
  traits: WorkspaceTrait[]
  /** The one its desktop shows (canvas in memory, browsers running). */
  focused: boolean
  /** Seated from the desktop's feed. False = a name only: no agents, no tray, counts null. */
  live: boolean
  /** Creation order, as the desktop keeps them. */
  agents: ZoomFleetAgent[]
  /** Notes and browsers wired to no agent. */
  loose: ZoomFleetAttachment[]
  counts: ZoomCounts | null
  /** Its newest browser: the feed's, else the last one it lists. Null for a name only. */
  newest: ZoomFleetAttachment | null
}

/**
 * live        seated from this desktop's feed
 * connecting  the feed is opening (or reopening): what is shown is the last
 *             snapshot, else the workspace names
 * listed      names only: another desktop, or a surface without a feed
 */
export type ZoomMachineDetail = 'live' | 'connecting' | 'listed'

export interface ZoomFleetMachine {
  /** Registry desktop id; LOCAL_MACHINE_ID for this desktop when the account does not list it. */
  id: string
  name: string
  /** The desktop this surface runs on, or the one the phone reads. */
  local: boolean
  online: boolean
  lastSeenAt: number | null
  appVersion: string | null
  profile: MachineProfile | null
  /** False when the registry says nobody is signed in on it; absent when it does not say. */
  signedIn?: boolean
  /** This desktop's display, from its own feed; another desktop's is not known. */
  display?: MachineDisplay | null
  detail: ZoomMachineDetail
  focusedWorkspaceId: string | null
  workspaces: ZoomFleetWorkspace[]
  /** Summed over the workspaces; null unless every one is live. */
  counts: ZoomCounts | null
}

export interface ZoomFleet {
  /** This desktop first, then the account's others in the registry's order. */
  machines: ZoomFleetMachine[]
  /** A failure worth saying (not a missing feature, not being signed out); the rows still show what is known. */
  error: string | null
  loading: boolean
}

/** This desktop's id when the account does not list it (no account, or not registered yet). */
export const LOCAL_MACHINE_ID = 'this-desktop'

export type FeedLink = 'connecting' | 'live' | 'none'

export interface FleetParts {
  snapshot: FleetSnapshot | null
  /** 'none' = this surface has no feed. */
  link: FeedLink
  list: WorkspaceList | null
  /** This desktop's name from machineName, for when nothing better is known. */
  name: string | null
  account: AccountMachines | null
  /**
   * The account's other machines this desktop holds a key for (main ·
   * machine-keys.ts), each as its own /api/fleet answers: read live, not by name.
   */
  remote?: Readonly<Record<string, FleetSnapshot>>
}

const countsOf = (workspace: FleetWorkspace): ZoomCounts => ({
  ...workspace.counts,
  waiting: workspace.agents.filter((a) => a.phase === 'waiting').length,
  working: workspace.agents.filter((a) => a.phase === 'thinking').length
})

const sumCounts = (workspaces: readonly ZoomFleetWorkspace[]): ZoomCounts | null =>
  workspaces.reduce<ZoomCounts | null>(
    (sum, w) =>
      sum && w.counts
        ? {
            agents: sum.agents + w.counts.agents,
            notes: sum.notes + w.counts.notes,
            browsers: sum.browsers + w.counts.browsers,
            waiting: sum.waiting + w.counts.waiting,
            working: sum.working + w.counts.working
          }
        : null,
    { agents: 0, notes: 0, browsers: 0, waiting: 0, working: 0 }
  )

const liveWorkspace = (workspace: FleetWorkspace): ZoomFleetWorkspace => ({
  id: workspace.id,
  name: workspace.name,
  icon: workspace.icon,
  traits: workspace.traits ?? [],
  focused: workspace.state === 'focused',
  live: true,
  agents: workspace.agents,
  loose: workspace.loose,
  counts: countsOf(workspace),
  newest: workspace.newest ?? lastBrowserOf(workspace)
})

/**
 * WHAT A TILE'S DECK SHOWS (owner, 2026-11-04: artifacts on the same page as
 * the agents, not only numbers): the newest browser on top, then the newest
 * note, so a workspace of both shows both, then whatever came last. Each thing
 * once, however many agents wear it.
 */
export function deckOf(w: Pick<ZoomFleetWorkspace, 'agents' | 'loose' | 'newest'>): ZoomFleetAttachment[] {
  const listed = [...w.agents.flatMap((a) => a.attachments ?? []), ...w.loose].reverse()
  const note = listed.find((a) => a.kind === 'note')
  const order = [w.newest, note, ...listed].filter((a): a is ZoomFleetAttachment => !!a)
  return [...new Map(order.map((a) => [a.id, a])).values()]
}

/** A desktop older than the feed's `newest`: the last browser it lists, its tray before its agents'. */
function lastBrowserOf(workspace: FleetWorkspace): FleetAttachment | null {
  const listed = [...workspace.agents.flatMap((a) => a.attachments), ...workspace.loose]
  return listed.findLast((a) => a.kind === 'browser') ?? null
}

const listedWorkspace = (workspace: { id: string; name: string }, focusedId: string | null): ZoomFleetWorkspace => ({
  id: workspace.id,
  name: workspace.name,
  icon: null,
  traits: [],
  focused: workspace.id === focusedId,
  live: false,
  agents: [],
  loose: [],
  counts: null,
  newest: null
})

const machineOf = (row: AccountMachine): ZoomFleetMachine => ({
  id: row.id,
  name: row.name,
  local: false,
  online: row.online,
  lastSeenAt: row.lastSeenAt,
  appVersion: row.appVersion,
  profile: row.profile,
  ...(row.signedIn === undefined ? {} : { signedIn: row.signedIn }),
  detail: 'listed',
  focusedWorkspaceId: null,
  workspaces: row.workspaces.map((w) => listedWorkspace(w, null)),
  counts: null
})

function localMachine(parts: FleetParts, row: AccountMachine | undefined): ZoomFleetMachine {
  const { snapshot, list } = parts
  const focusedWorkspaceId = snapshot ? snapshot.focusedWorkspaceId : (list?.activeId || null)
  const workspaces = snapshot
    ? snapshot.workspaces.map(liveWorkspace)
    : list
      ? list.workspaces.map((w) => listedWorkspace(w, focusedWorkspaceId))
      : (row?.workspaces ?? []).map((w) => listedWorkspace(w, null))
  return {
    id: row?.id ?? LOCAL_MACHINE_ID,
    name: snapshot?.machine.name || row?.name || parts.name || 'This desktop',
    local: true,
    // Read by this surface right now: up, whatever the registry last heard.
    online: true,
    lastSeenAt: snapshot?.at ?? row?.lastSeenAt ?? null,
    appVersion: snapshot?.machine.appVersion ?? row?.appVersion ?? null,
    profile: snapshot?.machine.profile ?? row?.profile ?? null,
    display: snapshot?.machine.display ?? null,
    detail: parts.link === 'none' ? 'listed' : parts.link === 'live' && snapshot ? 'live' : 'connecting',
    focusedWorkspaceId,
    workspaces,
    counts: snapshot ? sumCounts(workspaces) : null
  }
}

/** Another machine of the account read through its own feed: drawn as this desktop is, but not this desktop. */
const readMachine = (row: AccountMachine, snapshot: FleetSnapshot): ZoomFleetMachine => ({
  ...localMachine({ snapshot, link: 'live', list: null, name: null, account: null }, row),
  id: row.id,
  local: false
})

/** Every machine the navigator can draw: this desktop first, then the account's others. */
export function composeFleet(parts: FleetParts): ZoomFleetMachine[] {
  const rows = parts.account?.ok ? parts.account.machines : []
  const current = rows.find((row) => row.current)
  const others = rows.filter((row) => row !== current).map((row) => {
    const read = parts.remote?.[row.id]
    if (!read) return machineOf(row)
    // Another machine's answer, from another version perhaps: one it cannot draw is drawn by name, and nothing else stops.
    try {
      return readMachine(row, read)
    } catch {
      return machineOf(row)
    }
  })
  return [localMachine(parts, current), ...others]
}

/** A fleet snapshot as another machine sent it, or null: only its shape is trusted. */
export const snapshotOf = (value: unknown): FleetSnapshot | null => {
  if (typeof value !== 'object' || value === null) return null
  const held = value as Partial<FleetSnapshot>
  if (typeof held.machine !== 'object' || held.machine === null || !Array.isArray(held.workspaces)) return null
  const readable = held.workspaces.every((w) => typeof w === 'object' && w !== null && Array.isArray(w.agents) && Array.isArray(w.loose))
  return readable ? (value as FleetSnapshot) : null
}

/** How often another machine's feed is read while the navigator is in sight. */
