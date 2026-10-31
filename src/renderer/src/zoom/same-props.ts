// WHEN A ZOOM NODE MAY SKIP A RENDER. The model is rebuilt on every crew
// update, so a node's view is a new object even when nothing in it changed,
// and the scene re-rendered every node on every commit (1,924 renders of the
// page thumbnails in 10 s at the full stop, where the scene is not even
// shown). Props are compared by content one level deep: a view object's own
// fields, arrays element by element. Functions compare by identity, so the
// caller hands stable ones (ZoomView's per-id handlers).

const sameArray = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return sameArray(a, b)
  return false
}

/** Two flat records with the same keys and the same values (arrays by element). */
export function sameFields(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return sameArray(a, b as unknown[])
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** React.memo's test for the zoom nodes: every prop the same, view objects by their fields. */
export function sameProps<P extends object>(prev: Readonly<P>, next: Readonly<P>): boolean {
  const kp = Object.keys(prev)
  if (kp.length !== Object.keys(next).length) return false
  return kp.every((k) => sameFields((prev as Record<string, unknown>)[k], (next as Record<string, unknown>)[k]))
}
