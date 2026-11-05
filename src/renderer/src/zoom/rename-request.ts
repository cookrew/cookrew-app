// ⋯ → RENAME (owner, 2026-11-04). The row lives in the zoomed card's ⋯
// (TerminalOverlay.tsx), the field in the full view's head or on the phone's
// bar (stage/StageView.tsx): this is where they meet. A request reaches the
// fields of that card only, synchronously, so the field focuses inside the
// tap and a phone raises its keyboard.

const listeners = new Map<string, Set<() => void>>()

/** A name field that answers ⋯ → Rename for card `id`; returns its unsubscribe. */
export function onRenameRequest(id: string, listener: () => void): () => void {
  const set = listeners.get(id) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(id, set)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(id) === set) listeners.delete(id)
  }
}

/** Open the rename field of card `id`. */
export function requestRename(id: string): void {
  for (const listener of [...(listeners.get(id) ?? [])]) listener()
}
