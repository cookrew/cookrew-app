import { cookrew } from '../api'
import type { BrowserNodeData, CanvasNode } from '../../../shared/model'

/**
 * MAGPIE'S SETTINGS IN A CARD. One card named "Magpie" per workspace: opened again,
 * it is pointed at the page instead of a second card appearing. The page's key never
 * comes here: main signs the card's own browser session in by the card's id and
 * answers with the bare address, which is all the card (and so the workspace, the
 * wall and the phone) ever holds (main/magpie-card-open.ts).
 */
export const MAGPIE_CARD_NAME = 'Magpie'

/** What main may hand back: Magpie's page on loopback, with no query, fragment or credentials. */
const BARE_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/

/**
 * Magpie's own settings, in its card: where a key for another computer's Magpie or a
 * vendor is typed into Magpie's page, never into a terminal, so it stays out of every
 * process's argv and every shell history (magpie's CLI takes keys only as arguments).
 * The sentence to show when it could not open, or null.
 */
export async function openMagpieSettings(): Promise<string | null> {
  const api = cookrew()
  const open = api.magpieWebOpen
  if (typeof open !== 'function') return 'Magpie’s settings open from the desktop app.'
  try {
    const state = await api.getWorkspace()
    const held = state.nodes.find((n): n is BrowserNodeData => n.kind === 'browser' && n.name === MAGPIE_CARD_NAME)
    const id = held?.id ?? crypto.randomUUID()
    const answer = await open(id)
    if (!answer.ok) return answer.why
    if (!BARE_RE.test(answer.url)) return 'Could not open Magpie’s settings.'
    if (held) {
      await api.updateNode(held.id, { url: answer.url } as Partial<CanvasNode>)
      return null
    }
    const right = state.nodes.reduce((edge, n) => Math.max(edge, n.position.x + n.size.width), 0)
    const card: BrowserNodeData = {
      kind: 'browser',
      id,
      name: MAGPIE_CARD_NAME,
      url: answer.url,
      position: { x: right + 110, y: 0 },
      size: { width: 1040, height: 720 }
    }
    await api.addNode(card as CanvasNode)
    return null
  } catch {
    return 'Could not open Magpie’s settings.'
  }
}
