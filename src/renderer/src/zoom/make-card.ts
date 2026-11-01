import type { CanvasNode } from '../../../shared/model'
import type { CookrewApi } from '../api'
import { zoomStore } from './zoom-store'
import { rememberHarness } from '../prompt/harness-pref'

/**
 * MAKING A CARD WITH THE CANVAS RETIRED (2026-10-30). There is no pane to
 * click, so nothing waits for a placement click: the crew's empty seat and
 * the dock's chips both make the card at once, here, and the zoom goes to it.
 * One path, so an agent from the dock and one from the seat cannot drift.
 */

export type Made = { ok: true; id: string | null } | { ok: false; error: string }

type MakeApi = Partial<Pick<CookrewApi, 'createTerminal' | 'addNode' | 'templateImport'>>

const GUTTER = 40

/**
 * Where a new card is stored: just right of everything already there. The
 * zoom does not read positions, but the workspace keeps them (the wall's map
 * draws them), and a pile at the origin reads as one card.
 */
export function nextSpot(nodes: readonly Pick<CanvasNode, 'position' | 'size'>[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 }
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    right = Math.max(right, node.position.x + node.size.width)
    top = Math.min(top, node.position.y)
  }
  return { x: Math.ceil((right + GUTTER) / GUTTER) * GUTTER, y: Math.max(0, Math.ceil(top / GUTTER) * GUTTER) }
}

export interface AgentChoice {
  name: string
  preset: string
  orch: boolean
  /** Boot from a saved role: its preset with the role prompt. */
  roleName?: string
  /** Its first prompt (the global prompt box), submitted once it has booted. */
  prompt?: string
}

/** A new agent in the active workspace; the zoom opens its card in the crew. */
export async function makeAgent(api: MakeApi, choice: AgentChoice, nodes: readonly CanvasNode[] = []): Promise<Made> {
  if (!api.createTerminal) return { ok: false, error: 'This build cannot create an agent.' }
  try {
    const created = await api.createTerminal({
      name: choice.name,
      preset: choice.preset,
      position: nextSpot(nodes),
      orch: choice.orch,
      ...(choice.roleName ? { roleName: choice.roleName } : {}),
      ...(choice.prompt ? { prompt: choice.prompt } : {})
    })
    // The next agent the prompt box makes takes the harness last used.
    if (!choice.roleName) rememberHarness(choice.preset)
    if (created?.id) {
      zoomStore.focusAgent(created.id)
      zoomStore.go(2, 'agents')
    }
    return { ok: true, id: created?.id ?? null }
  } catch (e) {
    return { ok: false, error: `That agent could not be made: ${String(e)}` }
  }
}

/** A new note or browser in the active workspace; the zoom opens the thumbnails on it. */
export async function makeItem(api: MakeApi, kind: 'note' | 'browser', nodes: readonly CanvasNode[] = []): Promise<Made> {
  if (!api.addNode) return { ok: false, error: `This build cannot create a ${kind}.` }
  const position = nextSpot(nodes)
  const node: CanvasNode =
    kind === 'note'
      ? { kind: 'note', id: crypto.randomUUID(), name: 'untitled', customName: null, content: '', locked: false, position, size: { width: 280, height: 220 } }
      : { kind: 'browser', id: crypto.randomUUID(), name: 'Browser', url: 'https://example.com', position, size: { width: 720, height: 560 } }
  try {
    const created = await api.addNode(node)
    const id = created?.id ?? node.id
    zoomStore.focusItem(id)
    zoomStore.go(0, 'items')
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: `That ${kind} could not be made: ${String(e)}` }
  }
}

/** `base`, or `base 2`, `base 3`… — the first not already a name among `taken`. */
export function freeName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/**
 * A NOTE OR A BROWSER, MADE INSIDE AN AGENT (owner, 2026-11-01): stored in the
 * active workspace and wired to the agent, so it is that agent's — in its full
 * view's column, in its `cookrew list` — and the rest of the crew reads it by
 * name like any card of their workspace (main/ask-reach.ts). Named after the
 * agent, and never a name the workspace already has: a teammate reaches it by
 * that name. The full view stays where it is; the caller opens the new card.
 */
export async function makeItemFor(
  api: Partial<Pick<CookrewApi, 'addNode' | 'connectNodes'>>,
  kind: 'note' | 'browser',
  agent: { id: string; name: string },
  nodes: readonly CanvasNode[] = []
): Promise<Made> {
  if (!api.addNode || !api.connectNodes) return { ok: false, error: `This build cannot create a ${kind}.` }
  const position = nextSpot(nodes)
  const name = freeName(`${agent.name} ${kind}`, nodes.filter((n) => n.kind === kind).map((n) => n.name))
  const node: CanvasNode =
    kind === 'note'
      ? { kind: 'note', id: crypto.randomUUID(), name, customName: null, content: '', locked: false, position, size: { width: 280, height: 220 } }
      : { kind: 'browser', id: crypto.randomUUID(), name, url: 'https://example.com', position, size: { width: 720, height: 560 } }
  let id: string
  try {
    const created = await api.addNode(node)
    id = created?.id ?? node.id
  } catch (e) {
    return { ok: false, error: `That ${kind} could not be made: ${String(e)}` }
  }
  try {
    await api.connectNodes(agent.id, id)
  } catch (e) {
    return { ok: false, error: `The ${kind} was made but could not be given to ${agent.name}: ${String(e)}` }
  }
  return { ok: true, id }
}

/** A saved team opens a session of its own: a new workspace, switched to. */
export async function importTeam(api: MakeApi, team: string): Promise<Made> {
  if (!api.templateImport) return { ok: false, error: 'This build cannot open a team.' }
  try {
    await api.templateImport(team)
    return { ok: true, id: null }
  } catch (e) {
    return { ok: false, error: `That team could not be opened: ${String(e)}` }
  }
}
