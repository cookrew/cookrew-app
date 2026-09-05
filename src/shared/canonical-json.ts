/**
 * ONE SPELLING FOR A SIGNED OBJECT.
 *
 * A reach card is signed on the desktop and verified at cookrew.dev, which
 * means two different programs have to agree, byte for byte, on what the
 * object "is". `JSON.stringify` does not give that: it preserves insertion
 * order, so `{lan, relay}` and `{relay, lan}` are the same card with two
 * different signatures, and a verifier that re-serialises what it parsed gets
 * whatever order its own parser happened to produce.
 *
 * So: keys sorted at every depth, no whitespace, arrays left in order (their
 * order is data). `undefined` members are dropped the way JSON.stringify drops
 * them; an explicit `null` is kept, because "no tailnet" is a fact worth
 * signing.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    return `{${entries.join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  if (typeof value === 'undefined' || typeof value === 'function') return 'null'
  return JSON.stringify(value) ?? 'null'
}
