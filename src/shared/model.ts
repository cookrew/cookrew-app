// Shared data model between main, renderer and CLI protocol.

export type NodeKind = 'terminal' | 'note' | 'browser'

export interface CanvasPosition {
  x: number
  y: number
}

export interface CanvasSize {
  width: number
  height: number
}

/** Lineage of a terminal forked from another agent's turn. */
export interface ForkOrigin {
  sourceId: string
  sourceName: string
  turnIndex: number
}

/** One reversible step: the session the agent was on before a restore. */
export interface RestorePoint {
  sessionId: string
  /** Epoch ms of the restore. */
  at: number
  /** Checkpoint the agent was rewound TO (for the undo label) — the rewind
   *  TARGET, not a source range. Named `rewoundToIndex` (M9): the old name
   *  `fromIndex` read as "where the rewind came FROM" and invited an
   *  off-by-semantics bug. */
  rewoundToIndex: number
  /** LEGACY persisted name of `rewoundToIndex` (pre-M9 undo stacks) —
   *  read-compat only, new writes never set it. Read via restorePointIndex(). */
  fromIndex?: number
}

/** The rewind target of a restore point, tolerant of pre-M9 persisted stacks. */
export function restorePointIndex(point: RestorePoint): number {
  return point.rewoundToIndex ?? point.fromIndex ?? 0
}

/** What a caller was told, and paid, when a served session was admitted. */
export interface ServedSessionFacts {
  /** The door's public origin and slug — the address, never a credential. */
  origin: string
  slug: string
  /** Epoch ms the session was admitted. */
  openedAt: number
  /**
   * What was paid, verbatim from the quote the caller approved. Absent on a
   * free door — and absent is not zero: "free" and "nothing yet" are
   * different statements, and only one of them is true here.
   */
  paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }
}

export interface TerminalNodeData {
  kind: 'terminal'
  id: string
  name: string
  preset: string
  command: string
  cwd: string
  orch: boolean
  role: string | null
  /**
   * WHAT THIS CARD WAS ADMITTED WITH — a placed orch card only.
   *
   * A caller pays once, at admission, for a session; after that the product
   * used to say nothing, and closing the card threw the session away in
   * silence. These are the facts they were shown at the gate, kept so the card
   * can state them and so the close prompt can quote a real price rather than
   * re-deriving one (a re-derived price would drift from what was charged).
   *
   * NO CREDENTIAL LIVES HERE. The Bearer and the account key stay in the main
   * process; this is the receipt, not the key.
   */
  servedSession?: ServedSessionFacts | null
  /** Set when this agent was forked from another agent's turn. */
  forkOf?: ForkOrigin | null
  /**
   * Claude Code session id this terminal is bound to at spawn
   * (--session-id / --resume), so session-file features (native fork)
   * locate the exact session on disk without guessing. Absent for
   * non-Claude presets and terminals from before ids were stored.
   */
  claudeSessionId?: string | null
  /**
   * Codex rollout file this terminal is bound to (~/.codex/sessions/...,
   * absolute path) — the Codex analogue of claudeSessionId, matched by
   * session_meta cwd + spawn-time window (note trace-sourced-context-final).
   */
  codexSessionRef?: string | null
  /**
   * OpenCode session id this terminal is bound to (`opencode --session <id>`),
   * the OpenCode analogue of claudeSessionId. Absent for other harnesses.
   */
  opencodeSessionId?: string | null
  /**
   * Pi session id discovered in this node's exclusive `--session-dir` after
   * Pi persists it, then resumed exactly with `--session <id>`. Absent for
   * other harnesses and for a new session before its first persisted reply.
   */
  piSessionId?: string | null
  /**
   * Claude session lineage: prior claudeSessionIds this node ran on, oldest
   * first (a /clear, restore, undo, or re-resolve each append one). The
   * checkpoint rail UNIONS across it so pre-clear endpoints stay visible and
   * rewind can reach into earlier session files. Capped; persisted with the
   * workspace.
   */
  sessionLineage?: string[]
  /** Undo stack for endpoint restore: prior sessions, newest first. */
  restoreStack?: RestorePoint[]
  /**
   * Context preamble a copy could not deliver at creation time because its
   * workspace was inactive (PTYs boot on activation). The switch boot
   * injects it once the terminal is live, then clears it. Absent otherwise.
   */
  pendingInject?: string | null
  position: CanvasPosition
  size: CanvasSize
}

export interface NoteNodeData {
  kind: 'note'
  id: string
  /** Slug name derived from first line unless customName is set. */
  name: string
  customName: string | null
  /** Markdown body. Persisted as a real .md file on disk. */
  content: string
  locked: boolean
  position: CanvasPosition
  size: CanvasSize
}

export interface BrowserTab {
  id: string
  url: string
  /** Last page title reported by the webview; empty until first load. */
  title: string
}

export interface BrowserNodeData {
  kind: 'browser'
  id: string
  name: string
  /** URL of the active tab (kept in sync for cards, `cookrew list`, older readers). */
  url: string
  /** Tab group; absent on workspaces saved before tabs existed — normalize via browserTabs(). */
  tabs?: BrowserTab[]
  activeTabId?: string
  position: CanvasPosition
  size: CanvasSize
}

export type CanvasNode = TerminalNodeData | NoteNodeData | BrowserNodeData

export interface Connection {
  id: string
  a: string
  b: string
}

export interface WorkspaceState {
  name: string
  /** Primary directory; kept === dirs[0] for back-compat. */
  dir: string
  /** Ordered working directories; dirs[0] is primary. */
  dirs: string[]
  nodes: CanvasNode[]
  connections: Connection[]
}

/** Sidebar entry for a workspace — its canvas lives in a separate file. */
export interface WorkspaceMeta {
  id: string
  name: string
  /**
   * URL identity — the `<slug>` in https://<host>/<slug> (marketplace §11).
   * Minted once from the name and FROZEN: a rename never moves it, because a
   * slug is an address a paired phone has bookmarked and an exported agent is
   * called at. Optional on the type for registries written before step 3;
   * the store backfills one at load.
   */
  slug?: string
  /** Primary directory; kept === dirs[0] for back-compat. */
  dir: string
  /** Ordered working directories; dirs[0] is primary. */
  dirs: string[]
  /** One emoji shown in the switcher. */
  icon: string
}

/** Git state of a workspace directory (main/git.ts). */
export interface GitInfo {
  isRepo: boolean
  root: string | null
  branch: string | null
  dirty: boolean
  ahead: number
  behind: number
  /** Set when the git query itself failed (not "not a repo"). */
  error?: string
}

/**
 * Normalize a workspace's directory list from either shape: a legacy
 * single `dir`, a `dirs` array, or both. Result is deduped, non-empty, and
 * its first entry is the primary. `primary` (when still present) is moved to
 * the front. Returns [] only when nothing usable is given.
 */
export function normalizeDirs(input: {
  dir?: string
  dirs?: string[]
  primary?: string
}): string[] {
  const raw = [
    ...(input.dirs ?? []),
    ...(input.dir !== undefined ? [input.dir] : [])
  ].map((d) => d.trim()).filter((d) => d.length > 0)
  const deduped = [...new Set(raw)]
  if (input.primary && deduped.includes(input.primary)) {
    return [input.primary, ...deduped.filter((d) => d !== input.primary)]
  }
  return deduped
}

/** What the renderer needs to render the workspace switcher. */
export interface WorkspaceList {
  workspaces: WorkspaceMeta[]
  activeId: string
}

export interface RoutineSpec {
  id: string
  name: string
  command: string
  schedule: { type: 'every'; ms: number } | { type: 'daily'; time: string }
  terminalId: string | null
  enabled: boolean
  fireCount: number
}

/** Per-node choice inside a team fork (terminals pick a turn strategy). */
export interface TeamForkChoice {
  nodeId: string
  /**
   * latest/first: single-turn fork (native Claude truncation when possible).
   * assembled: replay turnIndexes as a preamble. role: fresh boot from a
   * saved role, no history.
   */
  mode: 'latest' | 'first' | 'assembled' | 'role'
  /** 1-based TurnRecord.index values from the source history (assembled). */
  turnIndexes?: number[]
  /** Saved role to boot from (mode 'role'). */
  roleName?: string
  /**
   * Which forked-workspace directory this terminal lands in. Defaults to its
   * source cwd when still present, else the primary. When the chosen dir is a
   * repo and the fork uses worktrees, the terminal is repointed to the
   * worktree path instead.
   */
  targetDir?: string
}

export interface TeamForkSpec {
  /** Name for the forked workspace; defaults to '<source> fork'. */
  name?: string
  /** Ids of ALL nodes to include (terminals, notes, browsers). */
  nodeIds: string[]
  /** Turn strategy per included terminal; terminals without one get 'latest'. */
  choices: TeamForkChoice[]
  /** Fork the SAVED snapshot of this team instead of the live canvas. */
  fromSavedTeam?: string
  /**
   * Which live canvas the nodeIds belong to. Defaults to the focused one for
   * callers that are a seat; the CLI passes the calling pane's workspace,
   * which with sessions resident need not be the focused one (marketplace §11).
   */
  fromWorkspaceId?: string
  /** Directory set for the forked workspace; defaults to the source dirs. */
  dirs?: string[]
  /**
   * When a target dir is a git repo, `git worktree add` a fresh branch and
   * point the forked terminal there (default true). False forks in place.
   */
  worktree?: boolean
}

/** Copy selected canvas nodes (+cables among them) into a workspace. */
export interface TeamCopySpec {
  /** Node ids to copy; cables among them travel too. */
  nodeIds: string[]
  /** Workspace that receives the copies (the active one = duplicate in place). */
  intoWorkspaceId: string
  /**
   * Workspace the nodes live in; defaults to the active one. Set by PASTE
   * when the clipboard was filled before a workspace switch.
   */
  fromWorkspaceId?: string
  /**
   * Spawn the copies into a FRESH git worktree of the selection's shared
   * repo workdir (requires every selected agent in one repo dir). The name
   * becomes the worktree dir + `cookrew/<slug>` branch. Explicitly
   * requested → failures throw; never the silent in-place fallback.
   */
  worktree?: { name: string }
  /**
   * CUT-paste identity transfer: these node ids keep their ORIGINAL id in
   * the target (ownership moves). Non-terminals only: terminals always
   * re-id because they carry sessions.
   *
   * STATEFULNESS CONTRACT: headless browser profiles (cookies, sessions,
   * localStorage) live on disk keyed by node id — so a cut-pasted browser
   * is a COMPLETE stateful transfer, while copy-paste and save→fork mint
   * fresh ids and are deliberately stateless.
   */
  preserveIdentity?: string[]
  /**
   * CUT-paste session transfer: these TERMINAL ids MOVE their conversation to
   * the copy instead of forking it — same session ref, same checkpoint
   * ordinals, no lineage transition.
   *
   * The two are separate because a terminal cannot do what a note does: it
   * must re-id (its id keys a live pty, a tmux session and a turn ledger, and
   * the source is still standing when the paste runs), yet the conversation
   * must still arrive. So identity moves for notes/browsers, and the SESSION
   * moves for terminals.
   *
   * Only a CUT may set this. A copy's source keeps running, and an inherited
   * ref would put two live processes on one rollout — which is exactly why
   * the fork engine nulls these bindings by default.
   */
  carrySessions?: string[]
}

export interface TeamCopyResult {
  workspaceId: string
  workspaceName: string
  copiedNodes: number
  copiedCables: number
  /**
   * True when the source workspace was inactive at paste time: detached
   * agents aren't turn-tracked, so the copied context is as of the last
   * visit to that workspace — surfaced, never silently pretended fresh.
   */
  staleSource?: boolean
}

/** One element of a team mini-graph (clipboard tray, template previews). */
export interface TeamGraphItem {
  id: string
  kind: CanvasNode['kind']
  name: string
  position: CanvasPosition
  size: CanvasSize
}

/**
 * The simplified shape of a set of elements: what they are, where they sit
 * relative to each other, and the cables among them. Rendered as a tiny SVG
 * (TeamGraphThumb) wherever a selection travels — the clipboard tray and
 * the saved-template picker.
 */
export interface TeamGraph {
  items: TeamGraphItem[]
  cables: { a: string; b: string }[]
}

/** One staged element, enough to preview it and ghost its landing spot. */
export interface TeamClipItem extends TeamGraphItem {
  /** Identity transfer on paste (cut, session-less kinds): stateful move. */
  moves: boolean
}

/** What the COPY-PASTE clipboard is holding, for the PASTE affordance. */
export interface TeamClipStatus {
  count: number
  fromWorkspaceName: string
  /** Source workspace id — lets the renderer detect a cross-workspace paste. */
  fromWorkspaceId: string
  /** True when a PASTE will also remove the sources (cut = move). */
  cut: boolean
  /** Set when the paste will spawn into a fresh worktree of this name. */
  worktreeName?: string
  /** The staged elements, pruned against reality (see TeamClipboard). */
  items: TeamClipItem[]
  /** Cables among the staged elements (both ends staged) — the thumbnail. */
  cables: { a: string; b: string }[]
}

/** Listing entry for a saved team snapshot (~/.cookrew/teams). */
export interface TeamMeta {
  name: string
  savedAt: number
  nodeCount: number
  terminalCount: number
  /** Mini-graph of the snapshot for template pickers (absent pre-feature). */
  preview?: TeamGraph
}

/**
 * Result of an ENDPOINT RESTORE — rewinding a live teammate in place to one of
 * its checkpoints. Refusals carry `reason` so the UI never pretends a rewind
 * happened (same honesty rule as the recover exact-context gate).
 */
export interface RestoreResult {
  ok: boolean
  id: string
  name: string
  /** Checkpoint the agent was rewound to. */
  checkpointIndex: number
  /** Why the restore was refused (present only when ok=false). */
  reason?: string
  /** Session the agent now runs (the truncated copy). */
  sessionId?: string
  /** Session it was on before — kept on the undo stack. */
  previousSessionId?: string | null
  /** True when this result came from undoing a previous restore. */
  undone?: boolean
}

/** Outcome of an agent recovery, surfaced to the roster toast (agent-recover). */
export interface RecoverResult {
  ok: boolean
  id: string
  name: string
  workspaceId: string
  workspaceName: string
  /** True when the PTY (re)booted now; false when deferred to workspace activation. */
  spawned: boolean
  /** Best-effort restore with no full snapshot (legacy pre-feature kill). */
  legacy: boolean
  /**
   * True when the EXACT prior session was restored (same ref + first turn).
   * False = the exact session couldn't be located, so the node's shell is
   * restored but NOT booted into a fresh/stray session (EXACT-CONTEXT gate) —
   * the toast says so instead of pretending.
   */
  exact: boolean
  /**
   * True when the prior session was still HELD by another live claude process
   * (a leftover background agent, a pane we cannot reach), so recovery had to
   * branch off a copy of it — `--fork-session`.
   *
   * The context is intact; the session id is new. Worth saying out loud
   * because the old id keeps living somewhere, and because the alternative
   * this replaced was a pty that booted, printed one error and died while the
   * card reported READY.
   */
  forked?: boolean
}

/** A reusable agent persona saved from a terminal node. */
export interface AgentRole {
  name: string
  preset: string
  command: string
  /** First message injected when an agent boots from this role. */
  rolePrompt: string
  savedAt: number
  /**
   * Checkpoint provenance (checkpoint-program-spec, save role from this
   * checkpoint): the session prompt-entry uuid and prompt text of the turn
   * the role was distilled from, plus an optional session-copy file name
   * (a snapshot the restore path can native-boot from). All absent for
   * roles saved without a checkpoint.
   */
  sourceTurnUuid?: string
  sourceTurnPrompt?: string
  sessionCopyRef?: string
}

/** A single request over the cookrew Unix socket (newline-delimited JSON). */
export interface CliRequest {
  id: string
  terminalId: string
  /**
   * The claude session the caller's own process tree says it is, when it could
   * be read. A CLAIM the app checks against its bindings — see caller-identity:
   * a background-spawned agent inherits its host pane's COOKREW_TERMINAL_ID, so
   * the env alone attributes its commands to the wrong card. Absent for
   * non-claude harnesses and for CLIs older than this field.
   */
  sessionId?: string | null
  cmd: string
  args: string[]
  flags: Record<string, string | boolean>
}

export interface CliResponse {
  id: string
  ok: boolean
  output?: string
  error?: string
  /**
   * Process exit code the CLI must leave with (delivery contract,
   * shared/ask-outcome.ts). Absent = 1, the ordinary failure. Present when the
   * caller's next action depends on WHICH failure it was: `unsubmitted` (3)
   * wants a carriage return, `dropped` (4) wants the brief resent, and
   * applying either remedy to the other case corrupts the input box.
   */
  exitCode?: number
}

export const DEFAULT_CANVAS_POSITION: CanvasPosition = { x: 240, y: 200 }
export const DEFAULT_TERMINAL_SIZE: CanvasSize = { width: 640, height: 420 }
export const DEFAULT_NOTE_SIZE: CanvasSize = { width: 280, height: 220 }
export const DEFAULT_BROWSER_SIZE: CanvasSize = { width: 720, height: 560 }

/** Tabs of a browser, synthesizing a single tab for pre-tabs workspaces. */
export function browserTabs(node: BrowserNodeData): BrowserTab[] {
  if (node.tabs && node.tabs.length > 0) return node.tabs
  return [{ id: `${node.id}-tab-0`, url: node.url, title: '' }]
}

export function activeBrowserTab(node: BrowserNodeData): BrowserTab {
  const tabs = browserTabs(node)
  return tabs.find((t) => t.id === node.activeTabId) ?? tabs[0]
}

/** Derive a note name from its first content line. */
export function noteNameFromContent(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  const slug = firstLine
    .toLowerCase()
    .replace(/[#*`>\-\[\]()!]/g, ' ')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'untitled'
}

/** Ensure a name is unique among existing names by appending (2), (3)... */
export function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base} (${n})`)) n += 1
  return `${base} (${n})`
}
