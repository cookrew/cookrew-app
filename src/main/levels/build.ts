// THE LEVELS SNAPSHOT, built from already-read inputs. Pure: no fs, no store,
// no clock of its own — the service (service.ts) reads the sources once per
// change and hands them here, which keeps every rule below testable with
// plain objects.
//
// Every workspace is in it, focused or not: a switch never kills an agent, so
// a background workspace's agents are running too. Agents are seated in
// creation order (the canvas's node order) and never re-sorted by status.

import { activeBrowserTab, browserTabs } from '../../shared/model'
import type { BoardPhase } from '../../shared/board'
import type { AgentTuning } from '../../shared/agent-tuning'
import type { BrowserNodeData, CanvasNode, GitInfo, NoteNodeData, TerminalNodeData, WorkspaceMeta, WorkspaceState } from '../../shared/model'
import type { TerminalActivity, TurnRecord } from '../../shared/turn'
import type {
  AgentPhase,
  Harness,
  LevelsAgent,
  LevelsAgentDetail,
  LevelsAttachment,
  LevelsWorkspace,
  PhaseSource,
  WorkspaceTrait
} from '../../shared/strata'
import { TRAITS_MAX, isWorkspaceTrait } from '../../shared/strata'
import { scrubShapes, type Scrub } from '../scrub'
import { hostOf, line, noteTitle, replyLine, statusVerb, taskLine } from './lines'
import { phaseSinceOf, phaseVerdict } from './phase'

/** What the builder remembers about an agent between builds: when its phase began. */
export interface PhaseMemory {
  phase: AgentPhase
  source: PhaseSource
  since: number | null
}

export interface LevelsInput {
  /** Registry order; the focused one among them. */
  workspaces: ReadonlyArray<{ meta: WorkspaceMeta; state: WorkspaceState }>
  focusedWorkspaceId: string | null
  /** L1: VERIFIED live activities (the board's own `live`), by terminal id. */
  live: ReadonlyMap<string, TerminalActivity>
  /** L2: the probe's phases. */
  probe: ReadonlyMap<string, BoardPhase>
  /** L3: the ledger, terminal id → history, oldest first. */
  ledger: ReadonlyMap<string, readonly TurnRecord[]>
  tuning: (terminalId: string) => AgentTuning | null
  harnessOf: (node: TerminalNodeData) => Harness
  /** The previous build's memory; absent entries mean "never seen". */
  memory: ReadonlyMap<string, PhaseMemory>
  now: number
  scrub?: Scrub
  /** The workspace's traits (traits.ts), strongest first. Absent = none. */
  traits?: (meta: WorkspaceMeta) => readonly WorkspaceTrait[]
}

export interface LevelsBuild {
  workspaces: LevelsWorkspace[]
  memory: Map<string, PhaseMemory>
}

/** 'anthropic/claude-opus-5-5' → 'claude-opus-5-5'. */
export function modelName(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null
  const bare = model.trim().split('/').pop() ?? ''
  return bare.length > 0 ? bare : null
}

const isAttachment = (node: CanvasNode | undefined): node is NoteNodeData | BrowserNodeData =>
  node !== undefined && (node.kind === 'note' || node.kind === 'browser')

/** Per attachment, the terminals wired to it in connection order; per terminal, its attachments. */
interface Wiring {
  terminalsOf: Map<string, string[]>
  attachmentsOf: Map<string, string[]>
}

/** Connections are undirected {a, b}; order is the canvas's connection order. */
export function wiringOf(state: WorkspaceState): Wiring {
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  const terminalsOf = new Map<string, string[]>()
  const attachmentsOf = new Map<string, string[]>()
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key) ?? []
    if (!list.includes(value)) map.set(key, [...list, value])
  }
  for (const { a, b } of state.connections) {
    const [x, y] = [byId.get(a), byId.get(b)]
    const pair =
      x?.kind === 'terminal' && isAttachment(y) ? [x, y] : y?.kind === 'terminal' && isAttachment(x) ? [y, x] : null
    if (!pair) continue
    push(terminalsOf, pair[1].id, pair[0].id)
    push(attachmentsOf, pair[0].id, pair[1].id)
  }
  return { terminalsOf, attachmentsOf }
}

function attachmentRow(node: NoteNodeData | BrowserNodeData, wired: readonly string[], scrub: Scrub): LevelsAttachment {
  const shared = wired.length > 1
  if (node.kind === 'note') return { id: node.id, kind: 'note', title: noteTitle(node, scrub), shared }
  return {
    id: node.id,
    kind: 'browser',
    title: line(node.name, scrub) ?? 'Browser',
    host: hostOf(activeBrowserTab(node).url),
    tabs: browserTabs(node).length,
    shared
  }
}

/** Prompts newest first: the in-flight one, then the ledger's — lazily, the walk stops early. */
function* promptsOf(inFlight: string | null, history: readonly TurnRecord[]): Generator<string | null> {
  if (inFlight !== null) yield inFlight
  for (let i = history.length - 1; i >= 0; i -= 1) yield history[i].prompt
}

function agentRow(
  node: TerminalNodeData,
  attachments: LevelsAttachment[],
  input: LevelsInput,
  scrub: Scrub,
  memory: Map<string, PhaseMemory>
): LevelsAgent {
  const activity = input.live.get(node.id)
  const history = input.ledger.get(node.id) ?? []
  const last = history.length > 0 ? history[history.length - 1] : undefined
  const verdict = phaseVerdict(activity, input.probe.get(node.id), history)
  const remembered = input.memory.get(node.id)
  // A probe cannot say when its phase began: keep the moment a change was
  // first seen, and admit ignorance on the very first sight.
  const since =
    phaseSinceOf(verdict, activity, history) ??
    (remembered === undefined ? null : remembered.phase === verdict.phase ? remembered.since : input.now)
  memory.set(node.id, { phase: verdict.phase, source: verdict.source, since })

  const live = verdict.source === 'live' ? activity : undefined
  const inFlight = live !== undefined && (verdict.phase === 'thinking' || verdict.phase === 'waiting')
  const task = taskLine(
    {
      title: inFlight ? live.title : last?.title,
      brief: node.brief,
      prompts: promptsOf(inFlight ? live.prompt : null, history)
    },
    scrub
  )
  const reply = inFlight
    ? (replyLine(live.glance?.message, scrub) ?? (verdict.phase === 'waiting' ? replyLine(last?.reply, scrub) : null))
    : replyLine(live?.reply ?? last?.reply, scrub)
  return {
    id: node.id,
    name: line(node.name, scrub) ?? node.id,
    harness: input.harnessOf(node),
    model: modelName(input.tuning(node.id)?.model),
    orch: node.orch === true,
    phase: verdict.phase,
    phaseSource: verdict.source,
    phaseSince: since,
    task,
    reply,
    status: live && verdict.phase === 'thinking' ? statusVerb(live.glance?.status, scrub) : null,
    turns: Math.max(history.length, activity?.turnCount ?? 0),
    attachments
  }
}

/** Closed-list words only, at most TRAITS_MAX; a lookup that throws is no traits, not a failed build. */
function traitsFor(input: LevelsInput, meta: WorkspaceMeta): WorkspaceTrait[] {
  try {
    return (input.traits?.(meta) ?? []).filter(isWorkspaceTrait).slice(0, TRAITS_MAX)
  } catch {
    return []
  }
}

function workspaceRow(
  meta: WorkspaceMeta,
  state: WorkspaceState,
  input: LevelsInput,
  scrub: Scrub,
  memory: Map<string, PhaseMemory>
): LevelsWorkspace {
  const wiring = wiringOf(state)
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  const rowOf = new Map<string, LevelsAttachment>()
  const attachment = (id: string): LevelsAttachment | null => {
    const node = byId.get(id)
    if (!isAttachment(node)) return null
    const cached = rowOf.get(id)
    if (cached) return cached
    const row = attachmentRow(node, wiring.terminalsOf.get(id) ?? [], scrub)
    rowOf.set(id, row)
    return row
  }
  const terminals = state.nodes.filter((node): node is TerminalNodeData => node.kind === 'terminal')
  const agents = terminals.map((node) => {
    const own = (wiring.attachmentsOf.get(node.id) ?? []).flatMap((id) => {
      const row = attachment(id)
      return row ? [{ ...row, owner: (wiring.terminalsOf.get(id) ?? [])[0] === node.id }] : []
    })
    return agentRow(node, own, input, scrub, memory)
  })
  const loose = state.nodes.flatMap((node) => (isAttachment(node) && !wiring.terminalsOf.has(node.id) ? [attachment(node.id)!] : []))
  const traits = traitsFor(input, meta)
  // Nodes are kept in creation order: the last browser is the newest.
  const newestNode = state.nodes.findLast((node) => node.kind === 'browser')
  const newest = newestNode ? attachment(newestNode.id) : null
  return {
    id: meta.id,
    name: line(meta.name, scrub) ?? meta.id,
    icon: meta.icon || null,
    // Only when there are some, so a desktop without them sends what it always did.
    ...(traits.length > 0 ? { traits } : {}),
    state: meta.id === input.focusedWorkspaceId ? 'focused' : 'background',
    agents,
    loose,
    ...(newest ? { newest } : {}),
    counts: {
      agents: terminals.length,
      notes: state.nodes.filter((node) => node.kind === 'note').length,
      browsers: state.nodes.filter((node) => node.kind === 'browser').length
    }
  }
}

export function buildLevels(input: LevelsInput): LevelsBuild {
  const scrub = input.scrub ?? scrubShapes
  const memory = new Map<string, PhaseMemory>()
  const workspaces = input.workspaces.map(({ meta, state }) => workspaceRow(meta, state, input, scrub, memory))
  return { workspaces, memory }
}

/** A note body is the owner's own text, but not unbounded. */
export const NOTE_CONTENT_MAX = 256 * 1024

/**
 * One agent's dive bootstrap: its row plus the bodies and addresses the
 * snapshot withholds. Browsers are live only in the focused workspace — a
 * background workspace's browsers are not running.
 */
export function agentDetail(
  workspace: LevelsWorkspace,
  state: WorkspaceState,
  agentId: string,
  scrub: Scrub = scrubShapes,
  gitPeek: (dir: string) => GitInfo | undefined = () => undefined
): LevelsAgentDetail | null {
  const agent = workspace.agents.find((a) => a.id === agentId)
  if (!agent) return null
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  const card = byId.get(agentId)
  const notes: LevelsAgentDetail['notes'] = []
  const browsers: LevelsAgentDetail['browsers'] = []
  for (const row of agent.attachments) {
    const node = byId.get(row.id)
    if (node?.kind === 'note') {
      const content = node.content.length > NOTE_CONTENT_MAX ? `${node.content.slice(0, NOTE_CONTENT_MAX)}\n…` : node.content
      notes.push({ id: node.id, title: row.title, content: scrub(content), shared: row.shared })
    } else if (node?.kind === 'browser') {
      const tabs = browserTabs(node).map((tab) => ({ id: tab.id, url: tab.url }))
      browsers.push({
        id: node.id,
        title: row.title,
        url: activeBrowserTab(node).url || null,
        tabs,
        live: workspace.state === 'focused',
        shared: row.shared
      })
    }
  }
  // The card as the desktop holds it, as /api/workspace sends it: the embed's
  // overlay reads preset, brief, orch and servedSession off it. Git only when
  // it is already cached for the cwd — a detail never causes a git fork.
  const git = card?.kind === 'terminal' ? gitPeek(card.cwd) : undefined
  const node = card?.kind === 'terminal' ? (git === undefined ? card : { ...card, git }) : undefined
  return { agent, workspaceId: workspace.id, notes, browsers, ...(node ? { node } : {}) }
}
