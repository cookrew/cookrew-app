/**
 * THE STRATA CONTRACT — cookrew.dev as three fixed levels (program 2026-10-21).
 *
 *   machines ──in──▶ workspaces ──in──▶ agents ──in──▶ the agent's terminal
 *            ◀─out──            ◀─out──        ◀─out──
 *
 * No free zoom or pan: the camera only rests on these stops, a horizontal swipe
 * moves one stop in or out, and an agent can be picked from ANY level to dive
 * straight into its terminal. The terminal itself is the companion's existing
 * full view, embedded unchanged; everything above it is new.
 *
 * Which part answers for which types (every part reads this whole file, and a
 * type changes for all of them at once or not at all):
 *   desktop   MachineProfile, LevelsSnapshot, LevelsEvent, LevelsAgentDetail
 *   registry  FleetMachine rows and FleetPresence for the signed-in account
 *   shell     joins both per machine, keeps them live, MachineLink, the embed
 *             handoff (ShellToEmbed / EmbedToShell)
 *   levels    StrataPath ⇄ URL, what each level shows, input mapping
 *   stage     camera stops and flights between AnchorIds
 *   figures   FigureArt with the anchors the stage flies to
 */

export const STRATA_VERSION = 1

/** Every free-text line a level shows (task, reply, titles) is cut to this. */
export const STRATA_LINE_MAX = 140

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
   * Same-origin base the shell reaches this desktop under: '/relay/@<user>/desktop/<deviceId>/'.
   * The registry admits the account cookie; the desktop admits its own pairing
   * token, which this browser keeps as localStorage 'cr_token:<deviceId>' (absent
   * = unpaired). Event streams carry it as ?token= because EventSource sends no headers.
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

// ── levels: served by each desktop ──────────────────────────────────────────
//
// GET  <base>api/levels               → LevelsSnapshot     (pairing token)
// GET  <base>api/levels/stream        → text/event-stream of LevelsEvent; the
//                                       first event is always a snapshot, then
//                                       deltas; a `:` line every 15 s (the relay
//                                       drops a stream silent for 120 s).
// GET  <base>api/levels/agents/<id>   → LevelsAgentDetail  (the embed's bootstrap)
// Every workspace is in the snapshot, not only the focused one: switching never
// kills an agent, so background workspaces' agents are running too. One stream
// per machine is the shell's whole live budget for levels 0–2.

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

export interface LevelsAttachment {
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

export interface LevelsAgent {
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
   * 'This session is being continued…'). Scrubbed, ≤ STRATA_LINE_MAX.
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
  attachments: LevelsAttachment[]
}

export interface LevelsWorkspace {
  id: string
  name: string
  icon: string | null
  /**
   * 'focused' = the one the desktop shows: canvas in memory, browsers running.
   * 'background' = agents still running, canvas read from disk, browsers not
   * running (an embed shows them as title + address, not live).
   */
  state: 'focused' | 'background'
  /** Creation order. Views never reorder by status: attention is a highlight, not a sort. */
  agents: LevelsAgent[]
  /** Notes and browsers wired to no agent: the workspace's tray. */
  loose: LevelsAttachment[]
  counts: { agents: number; notes: number; browsers: number }
}

export interface LevelsSnapshot {
  v: typeof STRATA_VERSION
  /** Monotonic per desktop process; each event carries the rev it produces. */
  rev: number
  at: number
  machine: { name: string; appVersion: string | null; profile: MachineProfile }
  focusedWorkspaceId: string | null
  workspaces: LevelsWorkspace[]
}

/**
 * Everything the embed needs to open ONE agent without switching the desktop's
 * focus (the terminal stream already works across workspaces). Full addresses
 * are fine here: only the owner's paired browser reads it, and it is not cached.
 */
export interface LevelsAgentDetail {
  agent: LevelsAgent
  workspaceId: string
  /** Bodies are scrubbed for display (lines.ts): never write one back. */
  notes: Array<{ id: string; title: string; content: string; shared: boolean }>
  browsers: Array<{ id: string; title: string; url: string | null; tabs: Array<{ id: string; url: string }>; live: boolean; shared: boolean }>
}

/**
 * A rev that is not exactly previous + 1 means a gap: drop the stream and reconnect.
 * Any change to a workspace's seating (an agent added, removed or moved) is ONE
 * 'workspace' event, counts and tray with it. A 'snapshot' may also arrive
 * mid-stream (a machine-only change, or more than 48 deltas at once) with
 * snapshot.rev = previous + 1: replace everything.
 */
export type LevelsEvent =
  | { type: 'snapshot'; snapshot: LevelsSnapshot }
  | { type: 'agent'; rev: number; workspaceId: string; agent: LevelsAgent }
  | { type: 'workspace'; rev: number; workspace: LevelsWorkspace }
  | { type: 'workspace-gone'; rev: number; workspaceId: string }
  | { type: 'focus'; rev: number; workspaceId: string | null }

// ── the shell's view of a machine ───────────────────────────────────────────

/**
 * unpaired  this browser holds no token for it (the pair flow, not an error)
 * connecting / live / offline  the levels stream's state
 * outdated  the desktop answers but has no levels API: offer the classic OPEN
 */
export type MachineLink = 'unpaired' | 'connecting' | 'live' | 'offline' | 'outdated' | 'error'

export interface StrataMachine extends FleetMachine {
  link: MachineLink
  /** Last snapshot seen, live or cached; null when never reached. */
  levels: LevelsSnapshot | null
  /** True while `levels` is a cache (link not live). */
  stale: boolean
}

// ── where the camera is ─────────────────────────────────────────────────────

export type StrataLevel = 'machines' | 'workspaces' | 'agents' | 'terminal'

/** Ids, not slugs. A dive from any level sets all three at once. */
export interface StrataPath {
  machine?: string
  workspace?: string
  agent?: string
}

export const levelOf = (path: StrataPath): StrataLevel =>
  path.agent ? 'terminal' : path.workspace ? 'agents' : path.machine ? 'workspaces' : 'machines'

/** One step out; the terminal steps out to its workspace's agents. */
export const parentOf = (path: StrataPath): StrataPath =>
  path.agent
    ? { machine: path.machine, workspace: path.workspace }
    : path.workspace
      ? { machine: path.machine }
      : {}

// URL (the levels part owns the slug rules): /me · /me/<machine> · /me/<machine>/<workspace>
// · /me/<machine>/<workspace>/<agent>. Every level is one history entry, so the
// browser's own back (iOS edge swipe included) is "out".

// ── what the camera flies between ───────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Every flight starts and ends on a registered anchor. Levels register their
 * items' DOM rects under these ids; the stage reads them once per flight,
 * never per frame.
 */
export type AnchorId =
  | `machine:${string}`
  | `portal:${string}`
  | `workspace:${string}`
  | `agent:${string}`
  | 'terminal'

/**
 * A drawn figure. Self-contained SVG markup — no external refs, no
 * filters that run per frame — in its own viewBox, plus named anchors in
 * viewBox units:
 *   machine    `portal` (where its workspaces' miniature sits: screen, rack window…)
 *   container  `slot:0`…`slot:n-1` (avatar seats, in order), `tray`, `label`
 *   avatar     `badge`, `fan` (where its attachment cards tuck behind)
 */
export interface FigureArt {
  svg: string
  viewBox: Rect
  anchors: Readonly<Record<string, Rect>>
}

// ── the dive: shell ⇄ the desktop's companion in embed mode ─────────────────
//
// The terminal is the companion's own full view (TerminalOverlay + the Dock,
// untouched), loaded same-origin from `<base>?embed=agent&agent=<id>` in an
// iframe the shell keeps warm — one document per desktop, because the renderer
// holds one desktop in module state. The shell page's CSP gains frame-src 'self'.
// Messages are checked against the shell's own origin both ways.

export type ShellToEmbed =
  | { type: 'strata:focus'; agentId: string; attachmentId?: string }
  | { type: 'strata:blur' }

export type EmbedToShell =
  /** A prewarmed document is up and listening with no agent mounted: the shell may send focus now. */
  | { type: 'strata:warm' }
  | { type: 'strata:ready'; agentId: string }
  | { type: 'strata:out' }
  | { type: 'strata:error'; code: 'not-found' | 'offline' | 'unauthorized' | 'unreachable'; detail?: string }
