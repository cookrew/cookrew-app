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
  // ~95k events). Re-baselined 2026-09-06 after event-log.ts started caching
  // the parsed rotated files (pinned to ino/size/mtime) and walking a limited
  // query newest-first: worst of three 50-sample runs, all under a load of
  // 6.6-15 per core, p50 5.67 / p95 16.09 / p98 21.48; the idle p50 is under
  // 5. Before the change the same shape measured p50 66.5 / p95 113.9 / p98
  // 151.4 IDLE (load 1.00) and p50 540-603 under load on 2026-09-05. At
  // CI's x3 a revert fails on p50 (66.5 vs 45) and p98 (151.4 vs 150); p95
  // alone would pass it (113.9 vs 120), so the clock is not the gate. The
  // structural gate beside it — one readFileSync per warm query (plus one
  // statSync per rotated file), and the read is events.jsonl — is what a
  // fast machine cannot fake.
  eventQueryLiveShape: { p50: 15, p95: 40, p98: 50 },
  // count() over the same shape and a 'turn.' prefix: the full walk that
  // remains after the cache (every cached row is visited, the live file is
  // parsed once). /api/events/query calls query() AND count(), so the route
  // pays for both; on the owner's real 13.5 MB log warm query 8.5 / count
  // 12.3 ms. Calibrated 2026-09-06, worst of three 50-sample runs at load
  // 1.15-1.18: p50 17.25 / p95 24.68 / p98 25.60.
  eventCountLiveShape: { p50: 35, p95: 50, p98: 60 },
  // Serialising a 120-node canvas with 4 KB notes, the shape of the heaviest
  // live workspace. 2026-09-05 under load: p50 0.19 / p95 2.3 / p98 3.5.
  workspaceStateSerialize120: { p50: 1, p95: 5, p98: 8 },
  // Planning (not applying) a sweep over 300 ledgers + 200 attachments +
  // 300 team session sidecars (three 100-file dirs: named, stale, lost).
  // 2026-09-06, after sidecars joined the plan, worst of three 50-sample
  // runs at load 0.9-1.3 per core: p50 26 / p95 53 / p98 74. Sidecars add
  // one stat per file and one parse per team JSON, so the count-shaped cost
  // is unchanged. The budget is kept where the 2026-09-05 pre-sidecar
  // fixture put it (p50 107 / p98 303 under a load of 119) rather than
  // tightened to this run, because this fixture models file COUNT only: on
  // the live store the sweep takes ~100 s, all of it in
  // collectReferencedAttachments reading every sidecar byte (1 GB) for
  // attachment citations — a pre-existing cost this fixture does not carry.
  storageSweepPlan: { p50: 200, p95: 400, p98: 500 },
  // Planning a sweep over 40 served-session sandboxes of 450 files each (the
  // live shape: ~6 MB plugin clones per sandbox) plus 6 residue dirs, TWICE
  // per sample (once with an open set, once blind). The cost is one stat per
  // file to find each sandbox's newest write. 2026-09-06 under load 3.9/core:
  // p50 108 / p95 111 / p98 112 (n=30).
  storageSweepServed40: { p50: 250, p95: 400, p98: 500 }
} as const

export const MEMORY = {
  /** EventLog append/flush/query cycles must retain nothing between them. */
  eventLogCyclesMb: 4,
  /**
   * What the EventLog keeps after its first query at the live shape: the
   * parsed rows of every rotated file (three 4 MB files, ~71k rows), pinned
   * to the files so they are never parsed again. Measured 2026-09-06 with
   * --expose-gc on the memory.perf.ts fixture (40 distinct names, no
   * details): 7.12 MB with repeated strings shared per file, 14.0 MB before
   * sharing. The owner's real 13.5 MB log, with details and far more
   * distinct ids, retains 9.41 MB. Bounded by keepFiles x maxBytes; the gate
   * holds THAT shape and fails the day the bound is lost, and a second
   * assertion holds later queries at zero growth.
   */
  eventLogRotatedCacheMb: 16,
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
