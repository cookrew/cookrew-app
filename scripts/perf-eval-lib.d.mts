/**
 * Types for scripts/perf-eval-lib.mjs, so tests/perf-eval-lib.test.ts
 * type-checks under tsconfig.node.json. The implementation stays plain JS
 * because launchd runs a copy of it with no checkout behind it.
 */

export interface Percentiles {
  count: number
  p50: number
  p95: number
  p98: number
  max: number
}

export type Verdict = 'ok' | 'warn' | 'fail'

export interface Budget {
  warn?: number
  fail?: number
}

export interface TimedSample {
  t: number
  value: number
}

export interface FileEntry {
  path: string
  bytes: number
}

export interface TeamSessions {
  slug: string
  sessions?: Record<string, string>
}

export interface SidecarListing {
  slug: string
  files: Array<{ name: string; bytes: number }>
}

export interface Orphan {
  slug: string
  file: string
  bytes: number
  teamMissing: boolean
}

export interface PsRow {
  pid: string
  ppid: string
  rss: string
  etime: string
  args: string
}

export interface AppProcess {
  pid: number
  role: string
  rssMb: number
  uptimeSec: number
}

export function percentiles(values: readonly number[]): Percentiles | null
export function judge(value: number | null | undefined, budget: Budget | undefined): Verdict
export function slopePerHour(samples: readonly TimedSample[]): number | null
export function bucketOf(relativePath: string): string
export function bucketStorage(entries: readonly FileEntry[]): { buckets: Record<string, number>; total: number }
export function orphanSidecars(teams: readonly TeamSessions[], sidecars: readonly SidecarListing[]): Orphan[]
export function parseEtime(text: string): number | null
export function pickAppProcesses(rows: readonly PsRow[]): AppProcess[]
export function parsePsTable(text: string): PsRow[]
export function latencyFromEvents(lines: readonly string[], since?: number): Record<string, Percentiles>
export function fmtMb(bytes: number): string
export function fmtMs(ms: number | null | undefined): string
export function renderTable(rows: ReadonlyArray<ReadonlyArray<string | number>>): string
export interface Check {
  name: string
  value: number | null | undefined
  unit: string
  verdict: Verdict
  note?: string
}
export function renderSection(title: string, section: { checks: readonly Check[]; verdict: Verdict }): string
export function renderBuckets(buckets: Record<string, number>): string
export function worstOf(verdicts: readonly Verdict[]): Verdict
