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
  storageSweepServed40: { p50: 250, p95: 400, p98: 500 },
  // ---- L5 Tempo (perf/tempo, 2026-09-06): the residency loops ----
  // A workspace switch under multi-instance, 8 workspaces × 20 terminals,
  // the target not yet resident: flush the outgoing canvas (one write),
  // load the incoming one (one read), emit. Worst of four 30-sample runs,
  // 2026-09-06 at load 4-8/core: p50 1.10 / p95 6.45 / p98 7.17 (0.23 /
  // 0.28 / 0.30 on the quietest). Structural: reads 1, writes 1, events 1.
  workspaceSwitch8x20: { p50: 3, p95: 13, p98: 15 },
  // One board-probe pass over 40 detached panes with NO herdr status, through
  // a real HerdrHostMultiplexer whose fake reads take 15 ms each (the pass
  // outlasts the 500 ms admission freshness window, as in the field). The
  // sync runner is called ZERO times; what is timed is the probe's OWN
  // main-thread hold — the sum of its synchronous segments between awaits,
  // never the awaits. Worst of three 10-sample runs 2026-09-06 at load
  // 3-4/core: p50 3.07 / p95 5.86 / p98 7.44. Structural: 0 sync
  // children, listings within 1 + ceil(pass/500 ms), 40 reads, 40 phases.
  probeTick40Detached: { p50: 7, p95: 12, p98: 15 },
  // A GET /api/board while a 2.4 s probe pass is in flight and the previous
  // pass gave it something to show: the read must not wait on the pass.
  // 2026-09-06, worst of three runs at load 3-4/core: p50 0.16 / p95 0.50 /
  // p98 1.14 (Atlas measured p95 1502 before the fix) for 30 reads paced
  // 40 ms. Structural: no read waited (>100 ms); an EMPTY board's first read
  // does wait, bounded at 1.5 s.
  boardReadDuringPass: { p50: 2, p95: 5, p98: 10 },
  // A GET /api/board on an all-attached idle fleet (the map is empty for
  // good, the sampler self-parks) with a 300 ms listing in flight: the read
  // answers at once because a pass has completed before. 2026-09-06, worst
  // of three runs at load 2/core: p50 0.31 / p95 2.33 / p98 2.60 for 6 reads (was 800-900 ms each on
  // a 900 ms listing when warm() keyed on emptiness). Structural: none
  // waited, phases 0, and the reads did restart the probe.
  boardReadIdleFleet: { p50: 2, p95: 5, p98: 10 },
  // One drain tick over 40 parked sessions × 5 terminals, all resident
  // (multi-instance), zero workspace reads. Worst of four 30-sample runs
  // 2026-09-06 at load 4-8/core: p50 0.14 / p95 1.74 / p98 3.27.
  drainTick40Parked: { p50: 1, p95: 4, p98: 7 },
  // The shipped default (multiInstance false): 10 parked sessions the store
  // evicted, registry entries alive, files on disk. The old wiring read each
  // file twice per tick; now the observing tick reads nothing and the
  // release tick reads each once. 2026-09-06, worst of three runs: p50 0.00 /
  // p95 0.01 / p98 0.07. Structural: observing 0, releasing 10, after 0.
  drainTick10ParkedSingle: { p50: 1, p95: 1, p98: 2 },
  // ---- One stream, T4 (2026-09-07): the index the fold used to serve ----
  // Materialising a 1,000-block chain through the stateless projection —
  // stream-materialise.ts over stream-projection.ts, the read that produces
  // the rail. This is the gate that REPLACES the five turn-store fold suites
  // deleted with the writer: there is no fold left to measure, and this is
  // the work the rail actually costs now.
  //
  // WRITING IT FOUND AN O(n^2). The replay loop called applyChangeSet — which
  // copies the whole snapshot — once per LINE, over a map it privately owned.
  // Measured 2026-09-07 before the fix: 250 blocks 1.45 ms, 500 5.94, 1,000
  // 24.2, 2,000 97.3, 4,000 407.3 — the per-block cost doubling at every step.
  // After applyChangeSetInto: 0.09 / 0.16 / 0.30 / 0.48 / 0.82 ms, flat to
  // slightly sublinear per block. The owner's busiest chain is 1,232 blocks.
  //
  // Calibrated after the fix, 30 samples at load 0.34: p50 0.43 / p95 1.29 /
  // p98 1.50. Budget at ~4x, because the number is small enough that GC noise
  // dominates it; the STRUCTURAL half is the real gate — one pass, one state
  // write, 1,000 rows, ordinals 1..1000 in order, zero anomalies — and no
  // machine can be quick enough to fake that.
  streamIndex1000: { p50: 2, p95: 5, p98: 6 },

  // ---- One stream, D6 (T5 QA 2026-09-07): what /stream/open actually costs
  // streamIndex1000 measures the PROJECTION with its lines already in hand —
  // it never reads a file. /stream/open's real cost is the WALK in front of
  // it, and that walk went unmeasured until the route exceeded a 30 s client
  // timeout on the owner's busiest card (9 transcripts, 1,048 exchanges).
  //
  // COLD is the honest floor: a card opening after a restart parses every
  // transcript in its chain, and nothing can make that free. WARM is the one
  // the defect is about — the same card opened again, off the persisted
  // snapshot, reading one document instead of nine.
  //
  // THE FIX, on the 9-file / 1,048-block / 13.3 MB fixture, 2026-09-07, both
  // sides on the same harness:
  //
  //   BEFORE  cold p50 60.5 / p95 78.7 ms · warm p50 68.3 / p95 127.1 ms,
  //           27 document reads for one open (nine files, three walks). The
  //           warm path was SLOWER than the cold one: the persisted snapshot
  //           was read, folded and then thrown at a walk that re-derived it.
  //   AFTER   cold p50 44.9 / p95 51.1 ms · warm p50 7.4 / p95 9.9 ms,
  //           2 document reads — one for the index walk, one for the tail's,
  //           each touching the cursor's file alone.
  //
  // WARM IS THE TIGHT GATE; COLD IS A CEILING, and the asymmetry is honest.
  // Worst of four strict runs, 30 samples, load ~1.5: warm p50 14 / p95 40 /
  // p98 55 — budgeted at the file's own ≥2x rule. Cold ran p50 53-77 with a
  // p98 between 83 and 731 and a max of 1,024: each sample parses 13 MB into
  // its own reader cache, so the tail is the ALLOCATOR's, not this change's,
  // and a tight budget there would flap rather than catch anything. It is
  // still gated, at the order of magnitude a real regression would cross.
  //
  // The STRUCTURAL half is the real gate: 1,048 rows and exactly two document
  // reads on the warm path, which no machine can be quick enough to fake. The
  // owner's real chain is ~30x these bytes; the ratio is what transfers, not
  // the milliseconds.
  streamOpenCold1048: { p50: 500, p95: 2000, p98: 2500 },
  streamOpenWarm1048: { p50: 30, p95: 80, p98: 120 }
} as const

/**
 * ---- L7 Courier (perf/courier, 2026-09-08): the remote canvas boot ----
 *
 * What a phone's boot ASKS FOR, counted at a fixture companion serving the
 * built renderer to a headless Chrome (tests/perf/remote-open.perf.ts). All
 * structural — a request count is the one thing a fast machine cannot fake,
 * and through the relay every request is an exchange of ~0.2 s.
 *
 * Measured 2026-09-08 on the owner's canvas (32 terminals / 51 notes / 93
 * browsers) over the LAN with 200 ms added per request: BEFORE the boot was
 * 75 requests before interactive — /api/workspace twice, /api/git thirty
 * times (one per card, though the payload carried it), 23 stream tails read
 * and discarded, 8 third-party font requests — and interactive came at
 * 8658 ms. AFTER: 17 requests, none third-party, interactive 1287 ms. The
 * budget below leaves room for the handful of small lists the boot still
 * makes (auth, account, workspaces, presets, roles, teams, activity,
 * capabilities) and for one asset chunk more; today's code fails it on four
 * counts at once.
 */
export const REMOTE_OPEN = {
  /** Requests until first card plus the two seconds after, streams excluded. */
  maxBootRequests: 24,
  maxWorkspaceFetches: 1,
  maxWorkspaceListFetches: 1,
  maxGitFetches: 0,
  maxTailReadsAtBoot: 0,
  maxThirdPartyRequests: 0
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
  /**
   * Rendering with the cache cleared each time: the renderer holds nothing.
   * Since 2026-09-06 that includes marked's last parse tree, which the custom
   * renderer kept alive (46 MB after one 1.3M-char parse) and which
   * note-markdown.ts now releases with an empty parse; the control renders
   * one 1.3M-char note and asserts the same budget. Measured after: 0.0 MB.
   */
  noteRenderNoCacheMb: 4,
  /**
   * The note-markdown render cache is bounded in BYTES: 8 MiB accounted at
   * 2 bytes per UTF-16 unit, keyed by a content hash, HTML stored flat
   * (perf lane L3, 2026-09-06). Before: the bound was 64 ENTRIES and 64
   * cached 64 KB notes retained 51.5 MB — 771 KB an entry, of which 83% was
   * the cons-string rope marked returns. After: 31 entries of this shape fit
   * (265 KB accounted each, 98% of the budget) and retain 3.66 MB, since V8
   * keeps this Latin-1 HTML at one byte a char. Twice the measurement is 8;
   * the budget is 12 so a two-byte (CJK) body that fills the whole 8 MiB
   * still passes, while a return to the entry-count bound (51 MB) or an
   * unflattened store (24 MB at 31 entries) fails outright.
   *
   * The map is not the whole module. Two side caches (oversized renders,
   * ill-formed bodies) each hold up to four renders under 2x the budget, so
   * the WORST CASE the module can retain is 8 + 16 + 16 = 40 MiB accounted
   * (about 20 MB real for Latin-1 text) — and only with the map full, ONE
   * note between 8 and 16 MiB accounted (two oversized notes can never be
   * resident together: each is over the budget, so together they are over
   * the cap) and up to four ill-formed bodies totalling 16 MiB. This budget
   * gates the map alone; the side-cache test in memory.perf.ts asserts the
   * 40 MiB bound with both caches populated.
   */
  noteRenderCacheMb: 12
} as const

export const RENDER = {
  /**
   * React commits per frame of a real pan gesture on the seeded demo canvas
   * (tests/perf/fixtures/render-census), counted through the React DevTools
   * hook shim in scripts/perf-dom-probe.mjs. Measured 2026-09-06 on the live
   * 170-node workspace after perf lane L6: 2.3-2.7 — ReactFlow's own
   * transform commit plus the LOD arbiter's settle. Before the lane it was
   * 2.4-2.6 as well: the count of commits never was the problem, WHAT each
   * commit rendered was. That is the structural assertion beside this:
   * ZERO card wrappers rendered by a pan that moves no card off the stage,
   * and zero renders of the app shell. The legacy fixture in the same file
   * (App's wiring before the lane) renders every card on every frame, so
   * the gate is known to see the trap it guards.
   */
  commitsPerPanFrameMax: 4
} as const

export const STORAGE = {
  /** Live event-log shape: what event-log.ts DEFAULTS to. */
  eventLog: { maxBytes: 4 * 1024 * 1024, keepFiles: 3 }
} as const
