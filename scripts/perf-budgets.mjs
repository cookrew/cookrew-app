/**
 * Budgets for scripts/perf-eval.mjs. warn = worth a look; fail = the eval
 * exits non-zero. Copied to ~/.cookrew/bin with the runner by perf:install.
 */
export const BUDGETS = {
  storage: {
    totalMb: { warn: 1500, fail: 3000 },
    growthMbPerDay: { warn: 50, fail: 200 },
    orphanSidecarMb: { warn: 0 },
    // Served-session sandboxes past the 30 d grace still on disk — what the
    // next boot sweep reclaims. The sweep runs only at boot, so this climbs
    // between restarts on purpose; it warns when a restart is worth doing.
    servedPastGraceMb: { warn: 50 },
    backupsMb: { warn: 50 }
  },
  memory: {
    // Resting RSS by role. The renderer budget is the phone diet's number
    // (≤600 MB resting, memory-diet handoff 2026-08-27); the desktop renderer
    // is allowed the same at warn and fails at the iOS jetsam cliff (1.5 GB).
    rssMb: {
      main: { warn: 300, fail: 512 },
      renderer: { warn: 600, fail: 1536 },
      gpu: { warn: 300, fail: 600 },
      utility: { warn: 150, fail: 300 }
    },
    risingMbPerHour: { warn: 20, fail: 60 },
    // Main-thread event-loop delay p95 over the app's last complete minute,
    // from GET /api/health (src/main/loop-health.ts). A healthy Electron main
    // sits under 10 ms; 50 is a loop that is starting to hold itself, 500 is
    // one timer in twenty waiting half a second. Capped at WARN under machine
    // load like the latency section — the ELU next to it says whose fault.
    loopDelayP95Ms: { warn: 50, fail: 500 },
    // Board probe herdr children per minute — listings AND pane reads, one
    // child each — from GET /api/health. The 3 s poll was 20 listings/min
    // plus a read per pixels-only pane whenever anything was detached; with
    // the board closed the number is 0, open and quiet it backs off to 1/min
    // plus the per-event reads. 10 says the ladder stopped climbing.
    boardChildrenPerMinute: { warn: 10 }
  },
  // The renderer DOM, measured by scripts/perf-dom-probe.mjs in a headless
  // Chrome at the phone viewport against the local companion (the same React
  // app the desktop runs). Calibrated 2026-09-06 on the 170-node Cookrew Dev
  // workspace after perf lane L6: 1,165 elements at rest, 0.0 commits per
  // idle frame, 84 card renders over a 60-frame pan (cards scrolling into
  // view; before the lane, 2,681 — every card on every commit), 5-6 layers.
  // Card renders per pan frame is the structural one: a return to an app
  // that re-renders per viewport frame puts every visible card back into
  // every commit (34 cards x 2.4 commits = 80 a frame) and fails outright.
  dom: {
    elements: { warn: 3000, fail: 6000 },
    cardRendersPerPanFrame: { warn: 4, fail: 20 },
    commitsPerPanFrame: { warn: 4, fail: 8 },
    layers: { warn: 24, fail: 60 },
    // Elements the board leaves mounted after it closes: none.
    boardResidueElements: { warn: 50, fail: 500 }
  },
  latency: {
    events: {
      'workspace.switched': { p95: { warn: 1000, fail: 3000 } },
      'terminal.booted': { p95: { warn: 8000, fail: 15000 } }
      // turn.completed is agent think time, not app latency: reported only.
    },
    api: {
      '/api/workspaces': { p95: { warn: 250, fail: 1000 } },
      '/api/workspace': { p95: { warn: 500, fail: 2000 } },
      '/api/state': { p95: { warn: 1000, fail: 3000 } },
      '/api/board': { p95: { warn: 2000, fail: 6000 } },
      '/api/events/query?limit=200': { p95: { warn: 800, fail: 2000 } }
    }
  }
}

