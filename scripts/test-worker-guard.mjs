// A POOL WORKER DIES WITH ITS RUN.
//
// tinypool's forked worker never listens for its parent going away, so a run
// killed mid-test (an agent's Bash tool timing out) left its forks running:
// measured 2026-11-16, three of them, 30+ minutes, 4.4 GB each. Loaded as a
// vitest setupFile, so it runs inside every fork; a no-op in a thread pool,
// which has no IPC channel to lose.
//
// SIGKILL, not process.exit: vitest replaces process.exit in its workers with
// one that only throws, so an exit here was swallowed and the orphan lived on.

const ARMED = Symbol.for('cookrew.test-worker-guard')

if (typeof process.send === 'function' && !process[ARMED]) {
  process[ARMED] = true
  process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'))
}
