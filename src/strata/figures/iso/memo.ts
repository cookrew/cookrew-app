// Memoization by input and a stable string hash: same input → the very same
// string, so callers can memoize on the input and never redraw per frame.

/** Memo cap: inputs are a small closed set except workspace names, so this never bites in practice. */
const MEMO_CAP = 2048

export const memo = <I, O>(draw: (input: I) => O): ((input: I) => O) => {
  const seen = new Map<string, O>()
  return (input: I): O => {
    const key = JSON.stringify(input)
    const hit = seen.get(key)
    if (hit !== undefined) return hit
    const out = draw(input)
    if (seen.size >= MEMO_CAP) seen.clear()
    seen.set(key, out)
    return out
  }
}

/** FNV-1a, 32 bit: names → archetypes, palettes and wobble seeds. */
export const hash = (text: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
