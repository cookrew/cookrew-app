import type { AgentRow } from './agent-rows'

/**
 * Structured filtering for the agents dock, from the two records that already
 * describe every agent everywhere: the durable registry (who they are) and the
 * cookrew event log (what happened to them, and when).
 *
 * Deliberately NOT text search over conversations. The event log carries no
 * conversation text by design (main/event-log.ts), and the turn ledger is
 * reachable only per-terminal — so these two give cross-workspace coverage at
 * no cost, where full-text would need a new main-process index.
 *
 * Pure: no React, no bridge.
 */

/** The shape this module needs from a CookrewEvent — nothing more. */
export interface FacetEvent {
  type: string
  entityId: string
  timestamp: number
}

/** Match the event-query contract while preventing a long-open board leak. */
export const MAX_RETAINED_FACET_EVENTS = 4000

/** Keep the newest event window; query results and live appends share this gate. */
export function retainFacetEvents(
  events: readonly FacetEvent[],
  limit = MAX_RETAINED_FACET_EVENTS,
): FacetEvent[] {
  if (events.length <= limit) return events as FacetEvent[]
  return events.slice(events.length - limit)
}

export interface Facet {
  value: string
  count: number
  /** Workspaces filter by id; their label is the name. */
  id?: string
}

export interface AgentFacets {
  workspaces: Facet[]
  presets: Facet[]
  roles: Facet[]
  states: Facet[]
}

export type AgentState = 'active' | 'inactive'

export interface AgentFilter {
  presets: string[]
  roles: string[]
  workspaceIds: string[]
  states: AgentState[]
}

export const EMPTY_FILTER: AgentFilter = {
  presets: [],
  roles: [],
  workspaceIds: [],
  states: [],
}

/**
 * The registry records the same harness under two spellings — this machine has
 * 154 "Claude Code" alongside 10 "claude", and 41 "Codex" alongside 3 "codex",
 * depending on which build spawned the agent. Unnormalised, the facet row shows
 * one harness as two chips with split counts, and filtering on either misses
 * the other half.
 *
 * Only known aliases fold; an unrecognised preset is left exactly as it is
 * rather than guessed at.
 */
const PRESET_ALIASES: Record<string, string> = {
  claude: 'Claude Code',
  'claude code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  shell: 'Shell',
  opencode: 'OpenCode',
}

export function normalizePreset(preset: string): string {
  return PRESET_ALIASES[preset.trim().toLowerCase()] ?? preset
}

/** Count by key, then order by count so the useful chips come first. */
function tally(values: (string | null)[]): Facet[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (value === null || value === '') continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export function buildFacets(rows: AgentRow[]): AgentFacets {
  // Workspaces filter by id but display by name, so they are tallied by hand.
  const byWorkspace = new Map<string, Facet>()
  for (const row of rows) {
    const seen = byWorkspace.get(row.workspaceId)
    byWorkspace.set(
      row.workspaceId,
      seen
        ? { ...seen, count: seen.count + 1 }
        : { value: row.workspaceName, count: 1, id: row.workspaceId },
    )
  }

  return {
    workspaces: [...byWorkspace.values()],
    presets: tally(rows.map((r) => normalizePreset(r.preset))),
    roles: tally(rows.map((r) => r.role)),
    states: tally(rows.map((r) => (r.active ? 'active' : 'inactive'))),
  }
}

/**
 * OR within a facet, AND across facets — the shape people expect from chips.
 * An empty facet means "no opinion", not "match nothing".
 */
export function applyFilter(rows: AgentRow[], filter: AgentFilter): AgentRow[] {
  const { presets, roles, workspaceIds, states } = filter
  return rows.filter((row) => {
    if (presets.length > 0 && !presets.includes(normalizePreset(row.preset))) return false
    if (roles.length > 0 && (row.role === null || !roles.includes(row.role))) return false
    if (workspaceIds.length > 0 && !workspaceIds.includes(row.workspaceId)) return false
    if (states.length > 0 && !states.includes(row.active ? 'active' : 'inactive')) return false
    return true
  })
}

/**
 * Events that say something happened TO AN AGENT. workspace.switched is a third
 * of the log on this machine and names no agent — including it would stamp
 * every agent with the moment you last changed workspace.
 */
const AGENT_EVENTS = new Set([
  'terminal.created',
  'terminal.recruited',
  'terminal.killed',
  'terminal.dismissed',
  'connection.made',
  'connection.removed',
])

/** terminalId → the newest moment the log saw that agent touched. */
export type EventClock = Readonly<Record<string, number>>

/**
 * The only cross-workspace "last touched" signal available: live turn state
 * exists for the loaded workspace alone, so without this every agent elsewhere
 * ranks by spawn time and the list is frozen in the past.
 */
export function eventClock(events: readonly FacetEvent[]): EventClock {
  const clock: Record<string, number> = {}
  for (const event of events) {
    if (!event.entityId || !AGENT_EVENTS.has(event.type)) continue
    const seen = clock[event.entityId]
    if (seen === undefined || event.timestamp > seen) clock[event.entityId] = event.timestamp
  }
  return clock
}
