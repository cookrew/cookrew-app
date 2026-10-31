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
import { hostOf, tintOf } from './zoom-layout'
import type { FrameModel, LinkModel, TieModel } from './zoom-frame'

export interface AgentView {
  id: string
  name: string
  preset: string
  orch: boolean
  phase: AgentPhase
  /** Its last reply is still unread: the face ticks (ink-status.ts). */
  unread?: boolean
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
}
export interface ZoomModel {
  frame: FrameModel
  agents: AgentView[]
  items: ItemView[]
  marks: MarkView[]
  /** Every machine from the real fleet, this desktop first. */
  machines: MachineView[]
  name: string
  browsers: number
  notes: number
  /** Items the thumbs grid leaves out (the totals above still count them). */
  hiddenItems: number
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

/** How many browsers and notes the thumbs grid draws. */
export const ITEMS_SHOWN = 12

export const PHASE_WORD: Record<AgentPhase, string> = { waiting: 'needs you', working: 'working', done: 'done', quiet: 'resting', offline: 'offline' }

/** One line of what an agent last said or does now. */
export function lineOf(row: AgentRow | undefined, brief: string | null | undefined): string {
  const t = row?.turn
  return t?.latest?.text?.trim() || t?.title?.trim() || t?.ask?.trim() || brief?.trim() || 'Nothing said yet.'
}

/** A browser or note as the cards draw it (the zoom's thumbnails, the pet card's strip); null for anything else. */
export function itemViewOf(n: CanvasNode, owners: string[]): ItemView | null {
  if (n.kind === 'browser') {
    const tab = activeBrowserTab(n)
    const title = tab.title?.trim() || n.name
    return { id: n.id, kind: 'browser', title, host: hostOf(tab.url), tint: tintOf(n.id), initial: (title.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase(), line: tab.url, owners }
  }
  if (n.kind === 'note') {
    const first = (n.content ?? '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
    return { id: n.id, kind: 'note', title: n.name, host: 'note', tint: tintOf(n.id), initial: '', line: first, owners }
  }
  return null
}

export interface ZoomInput {
  nodes: readonly CanvasNode[]
  connections: readonly Connection[]
  /** Every workspace's rows: the other workspaces' marks are drawn from them. */
  rows: readonly AgentRow[]
  /** This workspace's crew (agent-rows.ts · crewOf): its agents. */
  crew: readonly AgentRow[]
  attachIndex: AttachmentIndex
  workspaces: readonly WorkspaceMeta[]
  activeId: string
  name: string
  /** The real fleet: this desktop and the account's others, from use-zoom-fleet.ts. */
  machines?: readonly {
    id: string
    name: string
    local: boolean
    online: boolean
    detail: 'live' | 'connecting' | 'listed'
    workspaces: readonly { id: string; name: string; agents: readonly { harness: string; phase: string }[]; counts: { agents: number; waiting: number } | null }[]
  }[]
}

/** One agent as every view draws it, from its row in the crew (agent-rows.ts · crewOf). */
export function agentViewOf(row: AgentRow, attachIndex: AttachmentIndex): AgentView {
  const list = attachIndex.get(row.id) ?? []
  const phase: AgentPhase = row.phase
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    orch: row.orch,
    phase,
    unread: row.unread === true,
    word: PHASE_WORD[phase],
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
  // Newest first: nodes are kept in creation order.
  const items: ItemView[] = []
  for (const n of [...input.nodes].reverse()) {
    const view = itemViewOf(n, owners.get(n.id) ?? [])
    if (view) items.push(view)
  }

  // A link per agent and item it carries, in the order the agent carries them.
  const links: LinkModel[] = []
  for (const a of agents) {
    const list = input.attachIndex.get(a.id) ?? []
    list.forEach((att, k) => {
      const o = owners.get(att.node.id) ?? []
      links.push({ key: `${a.id}|${att.node.id}`, agent: a.id, item: att.node.id, k, j: Math.max(0, o.indexOf(a.id)) })
    })
  }
  // The thumbs grid draws a screenful, not a board: a workspace can hold hundreds of
  // browsers and notes (292 on the owner's), and one tall strip of them is no view.
  // The ones somebody carries come first, newest first within each; the totals
  // still count them all, and the rest are said, not drawn.
  const totalCount = items.length
  const total = [...items]
  const shown = [...items.filter((i) => i.owners.length > 0), ...items.filter((i) => i.owners.length === 0)].slice(0, ITEMS_SHOWN)
  const keep = new Set(shown.map((i) => i.id))
  items.length = 0
  items.push(...shown)
  const keptLinks = links.filter((l) => keep.has(l.item))
  links.length = 0
  links.push(...keptLinks)
  const newestBrowser = items.find((i) => i.kind === 'browser' && i.owners.length > 0)
  const newest = newestBrowser ? `${newestBrowser.owners[0]}|${newestBrowser.id}` : null

  const ties: TieModel[] = []
  for (const c of input.connections) {
    if (agentIds.has(c.a) && agentIds.has(c.b)) ties.push({ key: c.id, a: c.a, b: c.b })
  }

  // The other workspaces: their agents from the roster, by workspace.
  const marks: MarkView[] = input.workspaces
    .filter((w) => w.id !== input.activeId)
    .map((w) => {
      const rows = input.rows.filter((r) => r.workspaceId === w.id)
      return { id: w.id, name: w.name, presets: rows.map((r) => r.preset), waiting: rows.some((r) => r.phase === 'waiting') }
    })
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
      active: input.activeId,
      newest
    },
    agents,
    items,
    marks,
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
    browsers: total.filter((i) => i.kind === 'browser').length,
    notes: total.filter((i) => i.kind === 'note').length,
    hiddenItems: Math.max(0, totalCount - shown.length)
  }
}
