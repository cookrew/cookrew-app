// A CARD, AS A WRIST READS IT.
//
// The watch draws the same card the desktop and the phone draw (zoom/AgentCard
// .tsx): face, name, state, the latest words, the menu it waits on, its
// thumbnails. A phone assembles that from the roster, the activity stream, the
// canvas and a checkpoint per card; a watch cannot afford those round trips or
// hold a stream open, so the same facts are put together here, one read per
// poll, bounded.
//
// The derivations are the app's own: turnViewOf and checkpointViewModel are
// what the card binds to, so a card cannot say one thing on the Mac and another
// on the wrist. Only the status table is restated, because the board's phases
// are not the roster's; a test holds it to ink-status.ts.

import type { BoardPhase, BoardRow } from '../shared/board'
import { activeBrowserTab, type CanvasNode, type Connection } from '../shared/model'
import type { TerminalActivity } from '../shared/turn'
import { choiceId, type WaitChoice } from '../shared/wait-choice'
import { checkpointViewModel, turnViewOf, type LatestCheckpoint, type TurnViewModel } from '../renderer/src/turn-view-model'
import { hostOf, tintOf } from '../shared/item-look'
import { parseUseUrl } from '../shared/use-url'

/** More than this is not a wrist's worth; the ones that need the owner sort first. */
export const MAX_CARDS = 40
/** One workspace's crew is shown whole, as the phone's crew view holds it; this only bounds a runaway canvas. */
export const MAX_CREW = 150
/** A card's artifacts: all of them, as the phone's thumbs grid holds them (owner, 2026-11-02), up to a wrist's worth. */
export const CARD_ITEMS = 24
/** A reply longer than this is cut: the rest is for a bigger screen. */
export const MAX_WORDS = 4000

export type WatchStatus = 'idle' | 'working' | 'waiting' | 'done' | 'offline'

/**
 * The face's state, by the card's own rule (agent-rows.ts · phaseOf): asleep
 * means the agent was closed, not that no pane is attached here. The board's
 * `offline` is the second: a resting agent nobody has a mirror of.
 */
const STATUS_OF: Record<BoardPhase, WatchStatus> = {
  working: 'working',
  waiting: 'waiting',
  unread: 'done',
  done: 'idle',
  offline: 'idle'
}

/** The word under a face (ink-status.ts · statusWord). */
const WORD_OF: Record<WatchStatus, string> = { idle: 'resting', working: 'working', waiting: 'needs you', done: 'done', offline: 'offline' }

/** The order the crown walks: what needs the owner first. */
const RANK: Record<WatchStatus, number> = { waiting: 0, done: 1, working: 2, idle: 3, offline: 4 }

export interface WatchItem {
  readonly id: string
  readonly kind: 'browser' | 'note'
  readonly title: string
  readonly host: string
  readonly tint: string
  readonly initial: string
  /** A device card's kind (shared/use-url.ts): a computer's screen is driven only once control is taken. */
  readonly use?: 'computer' | 'phone' | 'hardware'
}

export interface WatchWords {
  readonly text: string
  readonly tone: 'working' | 'waiting' | 'done'
  readonly full?: string
}

export interface WatchCard {
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly orch: boolean
  readonly workspace: { readonly id: string; readonly name: string; readonly active: boolean }
  readonly status: WatchStatus
  readonly word: string
  readonly words: WatchWords | null
  /** What the turn is about: its title, or the ask. */
  readonly about: string | null
  /** The menu it waits on, with the id an answer must name (main/menu-answer.ts). */
  readonly choice: (WaitChoice & { readonly id: string }) | null
  readonly items: readonly WatchItem[]
  readonly browsers: number
  readonly notes: number
  readonly at: number
}

export interface WatchCardsInput {
  readonly rows: readonly BoardRow[]
  readonly activities: ReadonlyMap<string, TerminalActivity>
  readonly checkpoints: ReadonlyMap<string, LatestCheckpoint | null>
  /** Still a member of the crew: false once it was closed. */
  readonly active: (agentId: string) => boolean
  readonly itemsOf: (agentId: string, workspaceId: string) => { items: readonly WatchItem[]; browsers: number; notes: number }
  /** How many cards at most: the day's MAX_CARDS, or a whole crew. */
  readonly limit?: number
}

const cut = (text: string): string => (text.length > MAX_WORDS ? `${text.slice(0, MAX_WORDS)}…` : text)

function wordsOf(view: TurnViewModel | null, status: WatchStatus): WatchWords | null {
  const latest = view?.latest
  if (latest) return { text: cut(latest.text), tone: latest.tone, ...(latest.full ? { full: cut(latest.full) } : {}) }
  // A detached pane says only that it is working; the card says no more than that.
  return status === 'working' ? { text: 'Working…', tone: 'working' } : null
}

const aboutOf = (view: TurnViewModel | null, row: BoardRow): string | null => view?.title ?? view?.ask ?? row.task?.title ?? (row.task?.summary || null)

/** Which rows are cards, in the crown's order: a stable sort, newest first inside a state. */
export function cardRows(rows: readonly BoardRow[], active: (agentId: string) => boolean = () => true, limit: number = MAX_CARDS): readonly BoardRow[] {
  const statusOf = (row: BoardRow): WatchStatus => (active(row.terminalId) ? STATUS_OF[row.phase] : 'offline')
  return [...rows]
    .sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)] || b.lastActivityAt - a.lastActivityAt || a.terminalId.localeCompare(b.terminalId))
    .slice(0, limit)
}

/**
 * ONE WORKSPACE'S CREW, AS EVERY OTHER VIEW OF IT COUNTS IT (agent-rows.ts ·
 * crewOf): one row per terminal card on its canvas, in card order. Its board
 * row when the board has one, under the card's own name, harness and lead
 * flag; a resting row when it has none, so an agent idle for a week, or one in
 * a workspace nobody is looking at, is still on the wrist.
 */
export function crewRows(
  nodes: readonly CanvasNode[],
  rows: readonly BoardRow[],
  workspace: { readonly id: string; readonly name: string; readonly active: boolean }
): BoardRow[] {
  const rowOf = new Map(rows.map((row) => [row.terminalId, row]))
  return nodes.flatMap((node): BoardRow[] => {
    if (node.kind !== 'terminal') return []
    const agent = { name: node.name, preset: node.preset, role: node.role ?? null, orch: node.orch === true }
    const row = rowOf.get(node.id)
    // Found by its terminal wherever the board filed it: a row with no registry entry goes under the active workspace.
    if (row) return [{ ...row, agent, workspace: { ...workspace } }]
    return [
      {
        terminalId: node.id,
        agent,
        workspace: { ...workspace },
        cwd: node.cwd,
        task: { title: null, summary: node.brief ?? '', turnIndex: 0, startedAt: 0, endedAt: 0 },
        phase: 'done',
        source: 'ledger',
        lastActivityAt: 0,
        turnCount: 0
      }
    ]
  })
}

export function watchCards(input: WatchCardsInput): WatchCard[] {
  return cardRows(input.rows, input.active, input.limit).map((row) => {
    const status = input.active(row.terminalId) ? STATUS_OF[row.phase] : 'offline'
    const activity = input.activities.get(row.terminalId)
    const live = activity ? turnViewOf(activity) : null
    const view = live?.latest ? live : (checkpointViewModel(input.checkpoints.get(row.terminalId) ?? null) ?? live)
    const choice = status === 'waiting' && activity?.waitChoice ? activity.waitChoice : null
    const { items, browsers, notes } = input.itemsOf(row.terminalId, row.workspace.id)
    return {
      id: row.terminalId,
      name: row.agent.name,
      preset: row.agent.preset,
      orch: row.agent.orch,
      workspace: row.workspace,
      status,
      word: WORD_OF[status],
      words: wordsOf(view, status),
      about: aboutOf(view, row),
      choice: choice ? { ...choice, id: choiceId(choice) } : null,
      items: items.slice(0, CARD_ITEMS),
      browsers,
      notes,
      at: row.lastActivityAt
    }
  })
}

/** A workspace as the wrist's tiles count it: what is in it, and what of that needs the owner. */
export interface WatchWorkspace {
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly agents: number
  readonly waiting: number
  readonly working: number
  readonly done: number
  /** Compact workspace-avatar data; empty when a desktop cannot read the canvas. */
  readonly presets: readonly string[]
  readonly artifacts: readonly WatchItem[]
}

export interface WatchWorkspacesInput {
  /** The Mac's workspaces, in its own order. */
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  readonly activeId: string
  readonly rows: readonly BoardRow[]
  /** The agents on a workspace's canvas, recent or not. */
  readonly agentsIn: (workspaceId: string) => number
  readonly active: (agentId: string) => boolean
  readonly avatarOf?: (workspaceId: string) => { presets: readonly string[]; artifacts: readonly WatchItem[] }
}

/**
 * Every workspace, the empty ones too: the wrist's workspaces stop is the
 * phone's, and a tile that vanished while it had nothing in it would move
 * every tile after it. Counted from the board's rows by the cards' own status
 * rule, so a tile never says "waiting" about a card that does not.
 */
export function watchWorkspaces(input: WatchWorkspacesInput): WatchWorkspace[] {
  const listed = [...input.workspaces]
  for (const row of input.rows) {
    if (!listed.some((w) => w.id === row.workspace.id)) listed.push({ id: row.workspace.id, name: row.workspace.name })
  }
  return listed.map(({ id, name }) => {
    const statuses = input.rows
      .filter((row) => row.workspace.id === id)
      .map((row) => (input.active(row.terminalId) ? STATUS_OF[row.phase] : 'offline'))
    const counted = (status: WatchStatus): number => statuses.filter((one) => one === status).length
    const avatar = input.avatarOf?.(id) ?? { presets: [], artifacts: [] }
    return {
      id,
      name,
      active: id === input.activeId,
      agents: Math.max(input.agentsIn(id), statuses.length),
      waiting: counted('waiting'),
      working: counted('working'),
      done: counted('done'),
      presets: avatar.presets,
      artifacts: avatar.artifacts.slice(0, 3)
    }
  })
}

/** One workspace's rows, or every row when none is asked for. */
export const rowsOfWorkspace = (rows: readonly BoardRow[], workspaceId: string | null): readonly BoardRow[] =>
  workspaceId === null ? rows : rows.filter((row) => row.workspace.id === workspaceId)

/** A browser's letter on its coin: the title's first letter or digit (zoom-model.ts · itemInitial). */
const initialOf = (title: string): string => (title.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()

export function itemOf(node: CanvasNode): WatchItem | null {
  if (node.kind === 'browser') {
    const tab = activeBrowserTab(node)
    const title = tab.title?.trim() || node.name
    const use = parseUseUrl(tab.url)?.use
    return { id: node.id, kind: 'browser', title, host: hostOf(tab.url), tint: tintOf(node.id), initial: initialOf(title), ...(use ? { use } : {}) }
  }
  if (node.kind === 'note') return { id: node.id, kind: 'note', title: node.name, host: 'note', tint: tintOf(node.id), initial: '' }
  return null
}

/** An agent's browsers and notes, through the cables, newest wire first. */
export function itemsOfAgent(
  agentId: string,
  state: { readonly nodes: readonly CanvasNode[]; readonly connections: readonly Connection[] }
): { items: WatchItem[]; browsers: number; notes: number } {
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const items: WatchItem[] = []
  for (const wire of [...state.connections].reverse()) {
    const other = wire.a === agentId ? wire.b : wire.b === agentId ? wire.a : null
    const node = other === null ? undefined : byId.get(other)
    if (!node || seen.has(node.id)) continue
    const item = itemOf(node)
    if (!item) continue
    seen.add(node.id)
    items.push(item)
  }
  return {
    items,
    browsers: items.filter((item) => item.kind === 'browser').length,
    notes: items.filter((item) => item.kind === 'note').length
  }
}
