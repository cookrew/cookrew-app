// PROTOTYPE highlight: one per level, moved by hover, arrows and the way out
// (coming out of an item highlights it). Imperative on purpose: hovering must
// never re-render a scene. Placeholder for the levels lane's selection model.

const chosen = new Map<string, string>()

export const highlightOf = (levelKey: string): string | undefined => chosen.get(levelKey)

export const setHighlight = (levelKey: string, id: string, el?: Element | null): void => {
  chosen.set(levelKey, id)
  if (!el) return
  for (const old of document.querySelectorAll(`[data-hl-level="${CSS.escape(levelKey)}"][data-hl]`)) {
    old.removeAttribute('data-hl')
    old.removeAttribute('data-stage-focus')
  }
  el.setAttribute('data-hl', '')
  el.setAttribute('data-stage-focus', '')
}

/** Arrow keys: the next or previous item of the level, wrapping. */
export const stepHighlight = (levelKey: string, delta: number): string | null => {
  const items = [...document.querySelectorAll<HTMLElement>(`[data-hl-level="${CSS.escape(levelKey)}"]`)]
  if (items.length === 0) return null
  const at = items.findIndex((el) => el.hasAttribute('data-hl'))
  const next = items[(Math.max(0, at) + delta + items.length) % items.length]
  const id = next.dataset.hlId ?? ''
  setHighlight(levelKey, id, next)
  next.focus({ preventScroll: false })
  return id
}
