/**
 * Percentile summary for a latency sample set. Lives in shared/ because BOTH
 * sides render the same numbers: main computes the metrics the board cards
 * and CLI notes show, and the renderer draws the same p95/p98 in its own
 * chips — two implementations would eventually disagree about the rank
 * convention (this is the numpy/type-7 one: rank = p/100 × (n-1), linear
 * interpolation between the closest ranks).
 *
 * Pure: the input array is copied before sorting and never mutated. Empty
 * input returns null — a latency summary with no samples must say "no data",
 * not render fabricated zeros.
 */
export interface LatencyStats {
  count: number
  p50: number
  p95: number
  p98: number
  max: number
}

export function latencyStats(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null
  // Numeric comparator: the default lexicographic sort orders 10 before 9
  // and would corrupt every rank. Slice first — sort mutates in place.
  const sorted = values.slice().sort((a, b) => a - b)
  const last = sorted.length - 1
  const percentile = (p: number): number => {
    const rank = (p / 100) * last
    const lo = Math.floor(rank)
    const hi = Math.ceil(rank)
    return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo])
  }
  return {
    count: sorted.length,
    p50: percentile(50),
    p95: percentile(95),
    p98: percentile(98),
    max: sorted[last]
  }
}
