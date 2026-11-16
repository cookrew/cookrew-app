import { cookrew } from '../api'
import type { BrowserNodeData, CanvasNode } from '../../../shared/model'

/**
 * MAGPIE'S SETTINGS IN A CARD. One card named "Magpie" per workspace: opened again,
 * it is pointed at the page instead of a second card appearing. The link carries
 * the page's key once; Magpie answers it with a cookie and sends the card to its
 * bare address (route/magpie-web.ts).
 */
export const MAGPIE_CARD_NAME = 'Magpie'

export async function openMagpieCard(url: string): Promise<void> {
  const api = cookrew()
  const state = await api.getWorkspace()
  const held = state.nodes.find((n): n is BrowserNodeData => n.kind === 'browser' && n.name === MAGPIE_CARD_NAME)
  if (held) {
    await api.updateNode(held.id, { url } as Partial<CanvasNode>)
    return
  }
  const right = state.nodes.reduce((edge, n) => Math.max(edge, n.position.x + n.size.width), 0)
  const card: BrowserNodeData = {
    kind: 'browser',
    id: crypto.randomUUID(),
    name: MAGPIE_CARD_NAME,
    url,
    position: { x: right + 110, y: 0 },
    size: { width: 1040, height: 720 }
  }
  await api.addNode(card as CanvasNode)
}
