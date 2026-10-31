import type { CanvasNode } from '../../../shared/model'
import type { CookrewApi } from '../api'
import { zoomStore } from './zoom-store'

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
      ...(choice.roleName ? { roleName: choice.roleName } : {})
    })
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
