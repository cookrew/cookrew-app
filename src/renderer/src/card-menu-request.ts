// The card menu's front door. Right-click belonged to the retired canvas, so
// SAVE ROLE, FORK and LANE had no way in (box user test 2, bug 9). Whatever
// holds a card asks here; App draws the one menu.

export interface CardMenuAsk {
  nodeId: string
  /** Viewport coordinates the menu opens at. */
  x: number
  y: number
}

const listeners = new Set<(ask: CardMenuAsk) => void>()

/** App's side; returns its unsubscribe. */
export function onCardMenuRequest(listener: (ask: CardMenuAsk) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function requestCardMenu(nodeId: string, x: number, y: number): void {
  for (const listener of [...listeners]) listener({ nodeId, x, y })
}
