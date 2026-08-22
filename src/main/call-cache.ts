/**
 * A SMALL MEMO FOR THE PRE-CREDENTIAL PATH (Tinker HIGH-2, ④ · S2 fixes).
 *
 * The call gate resolves an agent NAME before it looks at any credential, and
 * that ordering is deliberate: answering 404 before 401 is what stops a caller
 * mapping the room by watching which code comes back. The cost is that an
 * unauthenticated flood reaches store.workspaceState() first, and for a
 * workspace that is not currently resident that is a readFileSync plus a
 * JSON.parse of the whole canvas — on the Electron main thread, which is the
 * thread the owner's UI draws on.
 *
 * The fix is NOT to check the credential first. It is to make the work cheap.
 *
 * WHY A TTL RATHER THAN INVALIDATION. The store emits `change` only for the
 * FOCUSED workspace, and the expensive case here is precisely the one that is
 * not focused — a workspace nobody is looking at, reachable only by its URL,
 * which §11 exists to make possible. There is no signal to subscribe to that
 * covers it, so the honest instrument is a short window rather than a
 * subscription that would silently miss the case it was added for.
 *
 * WHAT STALENESS COSTS, precisely. At most one window during which a
 * just-created agent is not yet addressable (404) or a just-deleted one still
 * resolves. The second is not a hole: the grant lookup behind it is exact —
 * mtime-invalidated, not timed — so a withdrawn export refuses immediately, and
 * a resolved-but-deleted node has no transcript to cut a version from and
 * answers 409. Nothing in the window can turn a refusal into a service.
 */

export interface BriefMemoOptions {
  ttlMs?: number
  now?: () => number
  /** Distinct keys held at once. A bound, so a key space cannot grow the heap. */
  maxKeys?: number
}

/** Long enough to absorb a flood, short enough that nobody debugs it. */
const DEFAULT_TTL_MS = 1000
const DEFAULT_MAX_KEYS = 64

/**
 * Memoize a one-argument lookup for a short window.
 *
 * Deliberately not a general cache: there is no invalidate, no size policy
 * worth tuning and no statistics. It exists to stop one specific unauthenticated
 * path from doing disk I/O per request, and anything more would invite reuse
 * somewhere correctness depends on freshness.
 */
export function memoizeBriefly<T>(
  lookup: (key: string) => T,
  options: BriefMemoOptions = {}
): (key: string) => T {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
  const entries = new Map<string, { at: number; value: T }>()

  return (key) => {
    const at = now()
    const hit = entries.get(key)
    if (hit !== undefined && at - hit.at < ttlMs) return hit.value

    const value = lookup(key)
    // Refreshed by delete-then-set so insertion order tracks recency, which is
    // what makes the eviction below drop the least recently refreshed key.
    entries.delete(key)
    entries.set(key, { at, value })
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
    return value
  }
}
