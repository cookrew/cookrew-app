import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect } from 'vitest'
import { latencyStats, type LatencyStats } from '../../src/shared/stats'

/**
 * The shared instrument for tests/perf. Every gate in this directory measures
 * the same way, so a number from one file can be compared with a number from
 * another, and with the calibration recorded in budgets.ts.
 *
 * Two disciplines, both borrowed from scratchpad/perf-eval-gate.mjs, which
 * was the first tail-latency gate this project had and which never ran in CI
 * because scratchpad/ is gitignored:
 *
 *   NEVER A MEAN. A mean hides the stall the user actually felt. Every
 *   measurement here is a percentile summary from src/shared/stats.ts — the
 *   same type-7 percentile the board cards and CLI notes render — so the
 *   number a test asserts is the number the product shows.
 *
 *   SHAPE BEFORE SPEED. A wall-clock threshold passes on a fast laptop with a
 *   broken algorithm. Every latency gate therefore also carries a structural
 *   assertion (reads, writes, listener counts, files on disk) that no machine
 *   can make pass by being quick.
 */

function clamp(value: number, lo: number, hi: number): number {
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo
}

/** Samples per measurement. Raise for a calibration run, never lower for CI. */
export const SAMPLES = clamp(Number(process.env.COOKREW_PERF_SAMPLES ?? 30), 10, 500)

/**
 * Wall-clock headroom multiplier. The budgets were calibrated on an idle
 * Apple Silicon machine; a shared CI runner is slower and noisier, so the
 * workflow sets this to 3. Structural assertions are never scaled.
 */
export const SCALE = clamp(Number(process.env.COOKREW_PERF_SCALE ?? 1), 1, 20)

/**
 * One-minute load average per core at the moment the suite loaded. The
 * numbers vitest.config.ts records (38s idle, 349s under a four-agent review
 * round) are why this exists: on a loaded machine a percentile measures the
 * OTHER processes, and asserting it would fail the tree for what the fleet
 * was doing. Measured on the owner's machine 2026-09-05: at load 12/core the
 * p50s held and the tails were 10x; at load 40/core even the p50s were 3-7x.
 * So every structural assertion always holds, and the wall-clock budgets
 * assert only when the machine can give an honest number — or when
 * COOKREW_PERF_STRICT=1 says to assert them regardless, which is what CI's
 * dedicated runners set. On a busy dev box the structure is the gate and the
 * clock is a report; the nightly workflow is the clock's authority.
 */
export const LOAD_PER_CORE = os.loadavg()[0] / Math.max(1, os.cpus().length)
export const WALL_CLOCK_ASSERTED = process.env.COOKREW_PERF_STRICT === '1' || LOAD_PER_CORE <= 1

let warnedAboutLoad = false
function warnOnceAboutLoad(): void {
  if (warnedAboutLoad) return
  warnedAboutLoad = true
  process.stdout.write(
    `perf: load ${LOAD_PER_CORE.toFixed(2)} per core — wall-clock budgets are REPORTED, not asserted (COOKREW_PERF_STRICT=1 to force)\n`
  )
}

export interface Sample<S> {
  elapsed: number
  structural: S
}

export interface Measured<S> {
  name: string
  stats: LatencyStats
  structurals: readonly S[]
}

export interface TailBudget {
  p50?: number
  p95: number
  p98?: number
}

/** Time a synchronous block, carrying the structural facts it produced. */
export function timed<S>(run: () => S): Sample<S> {
  const started = performance.now()
  const structural = run()
  return { elapsed: performance.now() - started, structural }
}

/**
 * Run once to warm module, JIT and filesystem paths (excluded), then collect
 * `samples` timed runs and summarise their tail.
 */
export async function measure<S>(
  name: string,
  run: () => Sample<S> | Promise<Sample<S>>,
  samples = SAMPLES
): Promise<Measured<S>> {
  await run()
  const collected: Sample<S>[] = []
  for (let i = 0; i < samples; i += 1) collected.push(await run())
  const stats = latencyStats(collected.map((s) => s.elapsed))
  if (!stats) throw new Error(`${name}: no latency samples`)
  const measured = { name, stats, structurals: collected.map((s) => s.structural) }
  report(measured)
  return measured
}

const REPORT_FILE = process.env.COOKREW_PERF_REPORT

/**
 * One line per measurement to stdout, and — when COOKREW_PERF_REPORT names a
 * file — one JSON line appended there, so a CI run can upload the numbers as
 * an artifact and a later run can be compared against them.
 */
export function report<S>(measured: Measured<S>): void {
  const { name, stats } = measured
  const ms = (v: number): string => v.toFixed(2)
  process.stdout.write(
    `perf ${name}: n=${stats.count} p50=${ms(stats.p50)}ms p95=${ms(stats.p95)}ms p98=${ms(stats.p98)}ms max=${ms(stats.max)}ms load=${LOAD_PER_CORE.toFixed(2)}\n`
  )
  if (!REPORT_FILE) return
  mkdirSync(path.dirname(REPORT_FILE), { recursive: true })
  appendFileSync(
    REPORT_FILE,
    `${JSON.stringify({ at: Date.now(), name, ...stats, loadPerCore: LOAD_PER_CORE, scale: SCALE })}\n`
  )
}

/**
 * Assert p50/p95/p98 against a budget, scaled for the machine class — when
 * WALL_CLOCK_ASSERTED (see LOAD_PER_CORE); otherwise report any overrun.
 */
export function expectTail<S>(measured: Measured<S>, budget: TailBudget): void {
  const checks: Array<[string, number, number | undefined]> = [
    ['p50', measured.stats.p50, budget.p50],
    ['p95', measured.stats.p95, budget.p95],
    ['p98', measured.stats.p98, budget.p98]
  ]
  for (const [label, value, limit] of checks) {
    if (limit === undefined) continue
    const scaled = limit * SCALE
    if (!WALL_CLOCK_ASSERTED) {
      warnOnceAboutLoad()
      if (value > scaled) process.stdout.write(`perf ${measured.name} ${label} ${value.toFixed(2)}ms over ${scaled}ms (not asserted under load)\n`)
      continue
    }
    expect(value, `${measured.name} ${label} ${value.toFixed(2)}ms over ${scaled}ms`).toBeLessThanOrEqual(scaled)
  }
}

/** Every structural sample must equal `expected` — one outlier is a bug, not noise. */
export function expectEvery<S, K extends keyof S>(measured: Measured<S>, key: K, expected: S[K]): void {
  const observed = [...new Set(measured.structurals.map((s) => s[key]))]
  expect(observed, `${measured.name} ${String(key)} observed ${observed.join(', ')}`).toEqual([expected])
}

export function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `cookrew-perf-${prefix}-`))
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

const MB = 1024 * 1024

function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('heap gates need --expose-gc: run through vitest.perf.config.ts (npm run test:perf)')
  }
  // Twice: the first pass can leave finalization-registry and weak-ref work
  // for the next cycle, and a single pass reads high by exactly that much.
  gc()
  gc()
}

export interface HeapGrowth {
  /** Retained after the loop, in MB, once garbage is collected. */
  retainedMb: number
  /** Retained per iteration, in KB — the slope a leak shows as. */
  perIterationKb: number
}

/**
 * Retained-heap growth across `iterations` of `step`. What is measured is what
 * survives a full collection, so transient allocation is invisible and only a
 * reference somebody kept shows up. A negative result is reported as zero.
 */
export async function heapGrowth(iterations: number, step: (i: number) => void | Promise<void>): Promise<HeapGrowth> {
  await step(0)
  collectGarbage()
  const before = process.memoryUsage().heapUsed
  for (let i = 1; i <= iterations; i += 1) await step(i)
  collectGarbage()
  const retained = Math.max(0, process.memoryUsage().heapUsed - before)
  const growth = { retainedMb: retained / MB, perIterationKb: retained / 1024 / iterations }
  process.stdout.write(
    `perf heap ${iterations} iterations: retained=${growth.retainedMb.toFixed(2)}MB per=${growth.perIterationKb.toFixed(2)}KB\n`
  )
  return growth
}
