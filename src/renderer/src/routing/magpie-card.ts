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
/** As many card ids as main takes in one ask (main/magpie-card-open.ts). */
const OFFER_MAX = 2000

/** The card pointed at the page: its url, and the tab it shows, since a card with tabs shows its active tab. */
function pointedAt(card: BrowserNodeData, url: string): Partial<BrowserNodeData> {
  if (!card.tabs || card.tabs.length === 0) return { url }
  const active = card.tabs.find((t) => t.id === card.activeTabId) ?? card.tabs[0]
  return { url, tabs: card.tabs.map((t) => (t.id === active.id ? { ...t, url } : t)) }
}

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
    // Every browser card is offered; main reuses one only if it signed that card in before, whatever it is called now.
    const browsers = state.nodes.filter((n): n is BrowserNodeData => n.kind === 'browser')
    // Cards named Magpie first, and no more than main takes.
    const offered = [...browsers.filter((n) => n.name === MAGPIE_CARD_NAME), ...browsers.filter((n) => n.name !== MAGPIE_CARD_NAME)].slice(0, OFFER_MAX)
    const answer = await open(offered.map((n) => n.id))
    if (!answer.ok) return answer.why
    if (!BARE_RE.test(answer.url)) return 'Could not open Magpie’s settings.'
    const held = browsers.find((n) => n.id === answer.cardId)
    if (!answer.fresh && held) {
      await api.updateNode(held.id, pointedAt(held, answer.url) as Partial<CanvasNode>)
      return null
    }
    const right = state.nodes.reduce((edge, n) => Math.max(edge, n.position.x + n.size.width), 0)
    const card: BrowserNodeData = {
      kind: 'browser',
      id: answer.cardId,
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
