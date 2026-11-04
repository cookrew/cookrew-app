/**
 * FROM THE APP'S DATA TO THE ZOOM'S MODEL. The open workspace's terminals are
 * its agents (the roster's rows lend them a phase and a latest line); its
 * browsers and notes are its items, owned through the cables
 * (terminal-attachments.ts); terminal↔terminal cables are its ties; the
 * workspace list and the roster give the other workspaces' marks.
 */
import type { AgentPhase, AgentRow } from '../agent-rows'
import type { TurnViewModel } from '../turn-view-model'
import { activeBrowserTab, type CanvasNode, type Connection, type WorkspaceMeta } from '../../../shared/model'
import type { AttachmentIndex } from '../terminal-attachments'
import { hostOf, screenAspectOf, tintOf } from './zoom-layout'
import type { FrameModel, LinkModel, TieModel } from './zoom-frame'
import { inkStatusOfRow, statusWord, type InkStatus } from './ink-status'

export interface AgentView {
  id: string
  name: string
  preset: string
  orch: boolean
  phase: AgentPhase
  /** Its last reply is still unread: the face ticks (ink-status.ts). */
  unread?: boolean
  /** What its face draws (ink-status.ts · inkStatusOfRow); the word and its colour follow it. */
  status: InkStatus
  word: string
  line: string
  browsers: number
  notes: number
  /** Its latest turn, for the card's latest block (AgentLatest.tsx); null when none is known. */
  turn: TurnViewModel | null
}
export interface ItemView {
  id: string
  kind: 'browser' | 'note'
  title: string
  host: string
  tint: string
  initial: string
  line: string
  owners: string[]
}
export interface MarkView {
  id: string
  name: string
  presets: string[]
  waiting: boolean
  /** How many of its agents wait for an answer. */
  waitingCount: number
  /** Its browsers and notes, from its desktop's feed; null when the feed has none (never a made-up zero). */
  browsers: number | null
  notes: number | null
  /** What its tile's deck shows, newest first (use-zoom-fleet.ts · deckOf); empty when the feed names none. */
  deck: ItemView[]
}
export interface ZoomModel {
  frame: FrameModel
  agents: AgentView[]
  items: ItemView[]
  /**
   * The workspace's newest browser by creation. The draft stands it beside the
   * stack whether or not an agent wears it; a carried one rides its coin there
   * (frame.newest), any other is drawn on its own (ZoomView · zv-wsnew).
   */
  newestItem: ItemView | null
  /** The items agents wear as coins that the thumbs grid does not draw: their coins need a face too. */
  coinItems: ItemView[]
  marks: MarkView[]
  /** The open workspace in the same form: its tile's words and deck (its ring and faces are the scene's). */
  openMark: MarkView
  /** Every machine from the real fleet, this desktop first. */
  machines: MachineView[]
  name: string
  browsers: number
  notes: number
  /** Items the thumbs grid leaves out (the totals above still count them). */
  hiddenItems: number
  /** The agents the device's marks draw, added up: this workspace's crew and each other workspace's. The machine's label says this number. */
  deviceAgents: number
}

/** Another machine from the real fleet: its workspaces, or only their names when it cannot be read. */
export interface MachineView {
  id: string
  name: string
  local: boolean
  online: boolean
  detail: 'live' | 'connecting' | 'listed'
  workspaces: { id: string; name: string; presets: string[]; waiting: boolean }[]
  agents: number | null
  waiting: number | null
}

/**
 * How many browsers and notes the thumbs grid holds: every one (owner,
 * 2026-11-02: the grid scrolls, so 12 hid the rest). The view mounts only the
 * rows on screen (ZoomView · ROW_BUFFER); this bounds the model of a runaway board.
 */
export const ITEMS_SHOWN = 1000

/**
 * How many coins an agent wears: its newest wires, the seats of its orbit
 * (zoom-frame.ts · agentLink). Each agent's own, never the grid's twelve: an
 * agent whose items were all older than the workspace's newest wore none
 * (owner, 2026-11-01).
 */
export const COINS_PER_AGENT = 4

/** One line of what an agent last said or does now. */
export function lineOf(row: AgentRow | undefined, brief: string | null | undefined): string {
  const t = row?.turn
  return t?.latest?.text?.trim() || t?.title?.trim() || t?.ask?.trim() || brief?.trim() || 'Nothing said yet.'
}

/**
 * What a node draws as, without its owners. Nodes are replaced, never edited,
 * when they change, so a node object always draws the same: the derived
 * fields (a parsed URL, a note's first line out of its whole text) are kept
 * per object and dropped with it.
 */
const drawn = new WeakMap<CanvasNode, Omit<ItemView, 'owners'> | null>()

/** A browser's letter, on its coin, its card and its full view's head: the title's first letter or digit. */
export const itemInitial = (title: string): string => (title.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()

function drawnOf(n: CanvasNode): Omit<ItemView, 'owners'> | null {
  const known = drawn.get(n)
  if (known !== undefined) return known
  let view: Omit<ItemView, 'owners'> | null = null
  if (n.kind === 'browser') {
    const tab = activeBrowserTab(n)
    const title = tab.title?.trim() || n.name
    view = { id: n.id, kind: 'browser', title, host: hostOf(tab.url), tint: tintOf(n.id), initial: itemInitial(title), line: tab.url }
  } else if (n.kind === 'note') {
    view = { id: n.id, kind: 'note', title: n.name, host: 'note', tint: tintOf(n.id), initial: '', line: firstNoteLine(n.content ?? '') }
  }
  drawn.set(n, view)
  return view
}

/** A note's first line worth reading, its heading marks gone; it stops at that line rather than splitting the whole text. */
function firstNoteLine(text: string): string {
  let at = 0
  while (at <= text.length) {
    const end = text.indexOf('\n', at)
    const line = text.slice(at, end < 0 ? text.length : end).replace(/^#+\s*/, '').trim()
    if (line) return line
    if (end < 0) break
    at = end + 1
  }
  return ''
}

/** A browser or note as the cards draw it (the zoom's thumbnails, the pet card's strip); null for anything else. */
export function itemViewOf(n: CanvasNode, owners: string[]): ItemView | null {
  const view = drawnOf(n)
  return view ? { ...view, owners } : null
}

export interface ZoomInput {
  nodes: readonly CanvasNode[]
  connections: readonly Connection[]
  /** Every workspace's rows, gone agents included: the other workspaces' marks fall back on them where `crews` has none. */
  rows: readonly AgentRow[]
  /** This workspace's crew (agent-rows.ts · crewOf): its agents. */
  crew: readonly AgentRow[]
  attachIndex: AttachmentIndex
  workspaces: readonly WorkspaceMeta[]
  /** Each workspace's browsers and notes, where its desktop's feed counts them (use-zoom-fleet.ts). */
  counts?: ReadonlyMap<string, { browsers: number; notes: number }>
  /** Who each workspace holds now, where its desktop's feed seats it: a tile's count, faces and waiting. */
  crews?: ReadonlyMap<string, readonly SeatedAgent[]>
  /** What each workspace's deck shows, newest first, where its desktop's feed names it. */
  decks?: ReadonlyMap<string, readonly DeckSource[]>
  /** False while the open workspace's canvas is still on its way: `nodes` is empty for lack of it. */
  loaded?: boolean
  activeId: string
  name: string
  /** The real fleet: this desktop and the account's others, from use-zoom-fleet.ts. */
  machines?: readonly {
    id: string
    name: string
    local: boolean
    online: boolean
    detail: 'live' | 'connecting' | 'listed'
    /** Its display in points, as its own feed tells it: the screen it is drawn with. */
    display?: { w: number; h: number } | null
    workspaces: readonly { id: string; name: string; agents: readonly { harness: string; phase: string }[]; counts: { agents: number; waiting: number } | null }[]
  }[]
}

/** An agent as its desktop's feed seats it. */
export interface SeatedAgent {
  harness: string
  phase: string
}
const waitingIn = (phases: readonly string[]): number => phases.filter((p) => p === 'waiting').length

/** A thing a tile's deck shows, as its desktop's feed names it. */
export interface DeckSource {
  id: string
  kind: 'browser' | 'note'
  title: string
  host?: string | null
}
/** How many things a tile's deck shows by name; the rest is its depth. */
export const DECK_SHOWN = 3
const deckView = (d: DeckSource): ItemView => ({ id: d.id, kind: d.kind, title: d.title, host: d.host ?? '', tint: tintOf(d.id), initial: itemInitial(d.title), line: '', owners: [] })

/** One agent as every view draws it, from its row in the crew (agent-rows.ts · crewOf). */
export function agentViewOf(row: AgentRow, attachIndex: AttachmentIndex): AgentView {
  const list = attachIndex.get(row.id) ?? []
  const phase: AgentPhase = row.phase
  const status = inkStatusOfRow(phase, row.unread === true)
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    orch: row.orch,
    phase,
    unread: row.unread === true,
    status,
    word: statusWord(status),
    line: lineOf(row, row.brief),
    browsers: list.filter((a) => a.kind === 'browser').length,
    notes: list.filter((a) => a.kind === 'note').length,
    turn: row.turn ?? null
  }
}

export function buildZoomModel(input: ZoomInput): ZoomModel {
  // The crew: one row per terminal card, the same list the agent group draws (agent-rows.ts · crewOf).
  const agents: AgentView[] = input.crew.map((row) => agentViewOf(row, input.attachIndex))
  // Orchestrators first: the first agent is on top of the stack and leads the crew.
  agents.sort((a, b) => Number(b.orch) - Number(a.orch))
  const agentIds = new Set(agents.map((a) => a.id))

  const owners = new Map<string, string[]>()
  for (const [terminalId, list] of input.attachIndex) {
    if (!agentIds.has(terminalId)) continue
    for (const a of list) owners.set(a.node.id, [...(owners.get(a.node.id) ?? []), terminalId])
  }
  // Newest first: nodes are kept in creation order. Only kind and owners are
  // read for all of them; the full view is built for the few that are drawn.
  const all = [...input.nodes].reverse().filter((n) => n.kind === 'browser' || n.kind === 'note')

  // A link per coin an agent wears: its newest wires (the attachment index lists them newest first).
  const links: LinkModel[] = []
  const worn = new Map<string, CanvasNode>()
  for (const a of agents) {
    const list = (input.attachIndex.get(a.id) ?? []).slice(0, COINS_PER_AGENT)
    list.forEach((att, k) => {
      const o = owners.get(att.node.id) ?? []
      links.push({ key: `${a.id}|${att.node.id}`, agent: a.id, item: att.node.id, k, j: Math.max(0, o.indexOf(a.id)) })
      worn.set(att.node.id, att.node)
    })
  }
  // The thumbs grid holds them all and scrolls (owner, 2026-11-02); a workspace can
  // hold hundreds (300 on the owner's), so the view mounts only the rows on screen.
  // The ones somebody carries come first, newest first within each; past
  // ITEMS_SHOWN the totals still count them, and the rest are said, not drawn.
  const totalCount = all.length
  const carried = (n: CanvasNode): boolean => (owners.get(n.id)?.length ?? 0) > 0
  const shown = [...all.filter(carried), ...all.filter((n) => !carried(n))].slice(0, ITEMS_SHOWN)
  const items: ItemView[] = shown.flatMap((n) => itemViewOf(n, owners.get(n.id) ?? []) ?? [])
  // A coin outside the grid still draws its item's face; it fades rather than docking in the thumbs.
  const inGrid = new Set(items.map((i) => i.id))
  const coinItems: ItemView[] = [...worn.values()].filter((n) => !inGrid.has(n.id)).flatMap((n) => itemViewOf(n, owners.get(n.id) ?? []) ?? [])
  // The newest carried browser, on a coin somebody wears (an old wire to a new page can sit past the seats).
  const newestBrowser = items.find((i) => i.kind === 'browser' && links.some((l) => l.item === i.id))
  const newest = newestBrowser ? (links.find((l) => l.item === newestBrowser.id)?.key ?? null) : null

  const ties: TieModel[] = []
  for (const c of input.connections) {
    if (agentIds.has(c.a) && agentIds.has(c.b)) ties.push({ key: c.id, a: c.a, b: c.b })
  }

  // The other workspaces: their agents from the roster, by workspace.
  const marks: MarkView[] = input.workspaces
    .filter((w) => w.id !== input.activeId)
    .map((w) => {
      // The feed seats who is there now; the roster, all it knows without one, also keeps every agent it ever held.
      const seated = input.crews?.get(w.id)
      const rows = seated ? [] : input.rows.filter((r) => r.workspaceId === w.id)
      const presets = seated ? seated.map((a) => a.harness) : rows.map((r) => r.preset)
      const counted = input.counts?.get(w.id)
      const waitingCount = waitingIn((seated ?? rows).map((a) => a.phase))
      return { id: w.id, name: w.name, presets, waiting: waitingCount > 0, waitingCount, browsers: counted?.browsers ?? null, notes: counted?.notes ?? null, deck: (input.decks?.get(w.id) ?? []).map(deckView) }
    })
  // The open workspace's crew, until its canvas comes: the feed's, or its tile would say "no agents".
  const openSeated = input.loaded === false ? input.crews?.get(input.activeId) : undefined
  const openWaiting = waitingIn((openSeated ?? agents).map((a) => a.phase))
  const order = input.workspaces.map((w) => w.id)
  if (!order.includes(input.activeId)) order.unshift(input.activeId)

  return {
    frame: {
      agents: agents.map((a) => ({ id: a.id, name: a.name, preset: a.preset, orch: a.orch, waiting: a.phase === 'waiting' })),
      items: items.map((i) => ({ id: i.id, kind: i.kind, owners: i.owners })),
      links,
      ties,
      workspaces: order,
      otherMachines: (input.machines ?? []).filter((m) => !m.local).length,
      screenAspect: screenAspectOf(input.machines?.find((m) => m.local)?.display),
      active: input.activeId,
      newest
    },
    agents,
    items,
    coinItems,
    newestItem: (() => {
      const node = input.nodes.findLast((n) => n.kind === 'browser')
      return node ? itemViewOf(node, owners.get(node.id) ?? []) : null
    })(),
    marks,
    openMark: {
      id: input.activeId,
      name: input.name,
      presets: openSeated ? openSeated.map((a) => a.harness) : agents.map((a) => a.preset),
      waiting: openWaiting > 0,
      waitingCount: openWaiting,
      // Its canvas not read yet: unknown, not empty.
      browsers: input.loaded === false ? null : all.filter((n) => n.kind === 'browser').length,
      notes: input.loaded === false ? null : all.filter((n) => n.kind === 'note').length,
      // The open workspace's own things: their real thumbnails, not the feed's names.
      deck: [...new Set([all.find((n) => n.kind === 'browser'), all.find((n) => n.kind === 'note'), ...all.slice(0, DECK_SHOWN)])].flatMap((n) => n ?? []).slice(0, DECK_SHOWN).flatMap((n) => itemViewOf(n, []) ?? [])
    },
    machines: (input.machines ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      local: m.local,
      online: m.online,
      detail: m.detail,
      workspaces: m.workspaces.map((w) => ({ id: w.id, name: w.name, presets: w.agents.map((a) => a.harness), waiting: w.agents.some((a) => a.phase === 'waiting') })),
      agents: m.workspaces.length && m.workspaces.every((w) => w.counts) ? m.workspaces.reduce((a, w) => a + (w.counts?.agents ?? 0), 0) : null,
      waiting: m.workspaces.length && m.workspaces.every((w) => w.counts) ? m.workspaces.reduce((a, w) => a + (w.counts?.waiting ?? 0), 0) : null
    })),
    name: input.name,
    browsers: all.filter((n) => n.kind === 'browser').length,
    notes: all.filter((n) => n.kind === 'note').length,
    hiddenItems: Math.max(0, totalCount - items.length),
    deviceAgents: agents.length + marks.reduce((n, m) => n + m.presets.length, 0)
  }
}
