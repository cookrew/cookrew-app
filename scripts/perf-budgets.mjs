/**
 * Budgets for scripts/perf-eval.mjs. warn = worth a look; fail = the eval
 * exits non-zero. Copied to ~/.cookrew/bin with the runner by perf:install.
 */
export const BUDGETS = {
  storage: {
    totalMb: { warn: 1500, fail: 3000 },
    growthMbPerDay: { warn: 50, fail: 200 },
    orphanSidecarMb: { warn: 0 },
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
    risingMbPerHour: { warn: 20, fail: 60 }
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

