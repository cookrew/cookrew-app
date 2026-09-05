/**
 * The perf budgets, in one place, with their calibration.
 *
 * HOW TO RE-BASELINE after an intentional performance change:
 *
 *   COOKREW_PERF_SAMPLES=50 npm run test:perf
 *
 * three times on an otherwise idle machine. Take the WORST observed p50/p95/
 * p98 across the three runs, then set the budget at no less than 2x that,
 * rounded up. Record the measurement next to the budget so the next person
 * can see how much headroom they are looking at. Never loosen a structural
 * assertion to make a wall-clock budget pass — the structure is the gate; the
 * clock is the alarm.
 *
 * Wall-clock budgets are in milliseconds and are multiplied by
 * COOKREW_PERF_SCALE at assertion time (the CI workflow uses 3). Memory
 * budgets are in MB of RETAINED heap after a full collection and are never
 * scaled — a leak is a leak on every machine.
 */

export const LATENCY = {
  // Team paste, measured 2026-08-14 on an idle machine after the O(n^2) →
  // batched rewrite: worst of three 50-sample runs p50 0.34 / p95 0.69
  // (n=10), 0.31 / 0.49 (n=30). Re-measured 2026-09-05 under a load of 119
  // on 10 cores: p50 1.02 / 2.28. The pre-rewrite p50s (3.74 / 17.57) stay
  // ABOVE these budgets, so a return to the old shape fails on time alone.
  teamPaste10: { p50: 3, p95: 6, p98: 10 },
  teamPaste30: { p50: 3, p95: 6, p98: 10 },
  // Event-log burst of 30 appends and one flush: p50 0.25 / p95 0.42 idle
  // (2026-08-14); p50 0.19-0.31 under load (2026-09-05).
  eventBurst30: { p50: 1, p95: 3, p98: 5 },
  // A query over a log the size the live machine carries (four 4 MB files,
  // ~80k events). 2026-09-05 under load: p50 540-603 / p95 978 / p98 1246.
  // This is a KNOWN cost — every query re-reads and re-parses every file
  // (event-log.ts readAll), and the live /api/events/query answered in 780ms
  // the same day — so the budget gates the regression, not the design.
  // Halving it is a change worth making; re-baseline when it lands.
  eventQueryLiveShape: { p50: 900, p95: 1500, p98: 1800 },
  // Serialising a 120-node canvas with 4 KB notes, the shape of the heaviest
  // live workspace. 2026-09-05 under load: p50 0.19 / p95 2.3 / p98 3.5.
  workspaceStateSerialize120: { p50: 1, p95: 5, p98: 8 },
  // Planning (not applying) a sweep over 300 ledgers + 200 attachments.
  // 2026-09-05 under load: p50 107 / p95 251 / p98 303. The cost is
  // collectReferencedAttachments reading every store file once per sweep.
  storageSweepPlan: { p50: 200, p95: 400, p98: 500 }
} as const

export const MEMORY = {
  /** EventLog append/flush/query cycles must retain nothing between them. */
  eventLogCyclesMb: 4,
  /** Node churn and workspace switching in a WorkspaceStore. */
  storeChurnMb: 6,
  /** Rendering with the cache cleared each time: the renderer holds nothing. */
  noteRenderNoCacheMb: 4,
  /**
   * The note-markdown render cache is bounded by ENTRY COUNT (64), not bytes,
   * so its retained size scales with note size. Measured 2026-09-05: 64
   * cached 64 KB notes retain 50.5 MB — ~790 KB per entry, the key plus a
   * rendered HTML string about four times the source. This budget holds
   * THAT shape and fails the day the bound is lost; a byte-bounded cache
   * (say 8 MB) would let it drop to single digits, and should re-baseline.
   * Headroom is generous because string layout is a V8 detail that moves
   * with Node minors; a lost bound shows as hundreds of MB, not 60.
   */
  noteRenderCacheMb: 96
} as const

export const STORAGE = {
  /** Live event-log shape: what event-log.ts DEFAULTS to. */
  eventLog: { maxBytes: 4 * 1024 * 1024, keepFiles: 3 }
} as const
