/**
 * WHAT A DESKTOP SAYS ABOUT ITSELF, and what the registry says about a desktop.
 *
 *   desktop   MachineProfile, FleetSnapshot, FleetEvent
 *   registry  FleetMachine rows and FleetPresence for the signed-in account
 *
 * The zoom view reads every other device through this (zoom-fleet.ts).
 */

export const FLEET_VERSION = 1

/** Every free-text line a level shows (task, reply, titles) is cut to this. */
export const FLEET_LINE_MAX = 140

// ── machines ────────────────────────────────────────────────────────────────

/**
 * Decided on the desktop by a probe, most specific first:
 * sandbox > cluster > cloud > vm > laptop | desktop | server.
 */
export type MachineKind = 'laptop' | 'desktop' | 'server' | 'cloud' | 'vm' | 'cluster' | 'sandbox' | 'unknown'

/**
 * What a machine figure is drawn from. NEVER in a profile: serial numbers,
 * hardware UUIDs, MAC addresses, or a hostname the owner did not choose.
 */
export interface MachineProfile {
  kind: MachineKind
  /** Vendor model id: 'MacBookPro18,1', 'Mac14,3', 'c7g.2xlarge'. */
  model: string | null
  /** Human label when known: 'MacBook Pro 16-inch (2021)', 'Mac mini', 'AWS EC2'. */
  label: string | null
  vendor: string | null
  os: 'darwin' | 'linux' | 'win32' | 'other'
  osVersion: string | null
  arch: string
  cpus: number | null
  memoryGb: number | null
  /** The probe facts that decided `kind` ('hw.model=Mac14,3', 'battery=absent'). */
  evidence: string[]
}

/**
 * The desktop's display in points (a laptop's own panel, else the primary):
 * the zoom draws the machine's screen at its proportions. Sent in the fleet
 * feed only, never to the registry.
 */
export interface MachineDisplay {
  w: number
  h: number
}

/** One machine of the signed-in account, as the registry lists it (level 0). */
export interface FleetMachine {
  /** Registry desktop id: stable across renames. */
  id: string
  name: string
  online: boolean
  lastSeenAt: number | null
  appVersion: string | null
  /** Null for a desktop older than the probe: drawn as `unknown`. */
  profile: MachineProfile | null
  /**
   * Where this desktop's API is reached down the relay, on the API host: '/api/m/<deviceId>' (machine-relay.ts).
   * The registry admits the account session, sent in its own header; the desktop admits its own pairing
   * token, which this browser keeps as localStorage 'cr_token:<deviceId>' (absent
   * = unpaired). The shell sends it as Authorization: Bearer on every request,
   * streams included: they run over fetch, so no token lands in a URL and a
   * silent stream can be caught.
   * Relay caps: 16 requests in flight per desktop (every open stream holds one),
   * 8 desktops online per account.
   */
  base: string
}

// ── registry: served by cookrew.dev, account cookie, same-origin ────────────
//
// GET  /v2/me/desktops            → FleetMachine[]   today's array: every row keeps
//                                   its older fields and gains the ones above
// GET  /v2/me/presence            → FleetPresence    every desktop in one answer, with the
//                                   account cap; the shell refreshes presence with this,
//                                   never the list

/**
 * Who is online right now, for every desktop of the account at once. A row's
 * online and lastSeenAt mean exactly what the list row's do (lastSeenAt is
 * `at` while online), so the shell lays a row over its list row as it stands.
 */
export interface FleetPresence {
  at: number
  /** Desktops the relay keeps online at once for one account. */
  cap: number
  /** How many are online now; at the cap the shell says '<online> of <total> online'. */
  online: number
  desktops: Array<Pick<FleetMachine, 'id' | 'online' | 'lastSeenAt'>>
}

// ── the feed: served by each desktop ────────────────────────────────────────
//
// GET  <base>api/fleet               → FleetSnapshot     (pairing token)
// GET  <base>api/fleet/stream        → text/event-stream of FleetEvent; the
//                                       first event is always a snapshot, then
//                                       deltas; a `:` line every 15 s (the relay
//                                       drops a stream silent for 120 s).
// Every workspace is in the snapshot, not only the focused one: switching never
// kills an agent, so background workspaces' agents are running too. One stream
// per machine is a reader's whole live budget.

/**
 * TurnPhase plus 'offline' (no live process, or its machine is unreachable).
 * Same meaning as the board's working / waiting / unread / done / offline.
 */
export type AgentPhase = 'idle' | 'thinking' | 'waiting' | 'replied' | 'offline'

/**
 * How the phase is known — the board's own split. Only 'live' comes from a
 * mirrored screen; 'probe' is the multiplexer's guess (it calls a busy Claude
 * idle), 'ledger' is the last recorded turn. Views must not dress a guess as fact.
 */
export type PhaseSource = 'live' | 'probe' | 'ledger'

export type Harness = 'claude' | 'codex' | 'opencode' | 'pi' | 'shell' | 'other'

export interface FleetAttachment {
  id: string
  kind: 'note' | 'browser'
  /** Note: its first line. Browser: the card's name. */
  title: string
  /** Browser only: host + path of the active tab, never a query string or fragment. */
  host?: string | null
  tabs?: number
  /** Wired to more than one agent. */
  shared: boolean
  /** In an agent's list: this agent was wired to it first. */
  owner?: boolean
}

export interface FleetAgent {
  id: string
  name: string
  harness: Harness
  /** Effective model without the provider prefix; null = the harness default. */
  model: string | null
  orch: boolean
  phase: AgentPhase
  phaseSource: PhaseSource
  phaseSince: number | null
  /**
   * What it is on: the Sous title, else the card's brief, else the first REAL
   * line of the current/last prompt — skip harness noise ('<task-notification>',
   * 'This session is being continued…'). Scrubbed, ≤ FLEET_LINE_MAX.
   */
  task: string | null
  /** First line of the latest reply, or the live glance message while thinking. Scrubbed. */
  reply: string | null
  /**
   * Live status verb while thinking ('Cerebrating…'), never a counter, so the
   * wire changes only with the verb: views draw the elapsed time from phaseSince.
   * Else null.
   */
  status?: string | null
  turns: number
  /** Wired notes and browsers, in connection order. */
  attachments: FleetAttachment[]
}

/**
 * A workspace's character, in words from this closed list only. The desktop
 * distils them from the owner's one-line brief, else from the project's README
 * and package.json, and sends these words and nothing else: never the text it
 * read. Views pick the container's theme from them and drop unknown words.
 */
export const WORKSPACE_TRAITS = ['code', 'docs', 'home', 'media', 'security', 'ops', 'data', 'play', 'design', 'ai', 'team'] as const
export type WorkspaceTrait = (typeof WORKSPACE_TRAITS)[number]
/** Traits a workspace row carries at most, strongest first. */
export const TRAITS_MAX = 3

export const isWorkspaceTrait = (word: unknown): word is WorkspaceTrait =>
  typeof word === 'string' && (WORKSPACE_TRAITS as readonly string[]).includes(word)

export interface FleetWorkspace {
  id: string
  name: string
  icon: string | null
  /** At most TRAITS_MAX words of WORKSPACE_TRAITS, strongest first. Absent from a desktop older than this field. */
  traits?: WorkspaceTrait[]
  /**
   * 'focused' = the one the desktop shows: canvas in memory, browsers running.
   * 'background' = agents still running, canvas read from disk, browsers not
   * running (an embed shows them as title + address, not live).
   */
  state: 'focused' | 'background'
  /** Creation order. Views never reorder by status: attention is a highlight, not a sort. */
  agents: FleetAgent[]
  /** Notes and browsers wired to no agent: the workspace's tray. */
  loose: FleetAttachment[]
  /**
   * Its newest browser, by creation: the zoom's device stop draws it beside
   * the workspace's agents, as the way in by its browsers (draft
   * group-motion-pivot.html). Absent when it has none, and from a desktop
   * older than this field.
   */
  newest?: FleetAttachment
  counts: { agents: number; notes: number; browsers: number }
}

export interface FleetSnapshot {
  v: typeof FLEET_VERSION
  /** Monotonic per desktop process; each event carries the rev it produces. */
  rev: number
  at: number
  machine: { name: string; appVersion: string | null; profile: MachineProfile; display?: MachineDisplay | null }
  focusedWorkspaceId: string | null
  workspaces: FleetWorkspace[]
}

/**
 * A rev that is not exactly previous + 1 means a gap: drop the stream and reconnect.
 * Any change to a workspace's seating (an agent added, removed or moved) is ONE
 * 'workspace' event, counts and tray with it. A 'snapshot' may also arrive
 * mid-stream (a machine-only change, or more than 48 deltas at once) with
 * snapshot.rev = previous + 1: replace everything.
 */
export type FleetEvent =
  | { type: 'snapshot'; snapshot: FleetSnapshot }
  | { type: 'agent'; rev: number; workspaceId: string; agent: FleetAgent }
  | { type: 'workspace'; rev: number; workspace: FleetWorkspace }
  | { type: 'workspace-gone'; rev: number; workspaceId: string }
  | { type: 'focus'; rev: number; workspaceId: string | null }
