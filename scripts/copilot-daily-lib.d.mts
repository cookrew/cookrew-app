/**
 * Types for scripts/copilot-daily-lib.mjs, so its test type-checks under
 * tsconfig.node.json. The implementation stays plain JS because launchd runs a
 * copy of it with no checkout behind it.
 */

export interface Quota {
  remaining: number
  entitlement: number
  resetDate: string
}

export interface Task {
  id: string
  title: string
  brief: string
}

export interface Issue {
  number: number
  title: string
  body: string
  author?: { login: string }
}

export interface GateRun {
  failures: string[]
  active: number
}

export interface Verdict {
  ok: boolean
  reason: string
}

export function dailyBudget(input: { remaining: number; resetDate: string; now: Date }): number
export function hardCap(budget: number, remaining: number): number
export function parseQuota(answer: unknown): Quota
export function nextPatch(version: string): string
export function releaseStage(input: {
  version: string
  tags: string[]
  published: string[]
  mainVersion: string
}): { version: string; stage: 'bump' | 'pr' | 'tag' | 'draft' }
export function missingAssets(names: string[]): string[]
export function vitestOutcome(report: unknown, root: string): GateRun
export function typeFailures(input: { ok: boolean; output: string; config: string }): string[]
export function trustedIssues<T extends Issue>(issues: T[], attempted: string[]): T[]
export function gateProfile(input: { writable: string[]; readable: string[]; home: string; listening: number[] }): string
export function collectBlockers(input: { raw: string; collides: (file: string) => boolean }): string[]
export function weakenedTests(diff: string): string | null
export function parseListening(netstat: string): number[]
export function tooBusy(input: { load: number; cores: number }): boolean
export const SANDBOX_EXCLUDED_SUITES: string[]
export function releaseBar(checks: { name: string; bucket: string }[]): 'passed' | 'failed' | 'pending'
export function ownerTask(brief: string): Task
export function parseVitestFailures(report: unknown, root: string): string[]
export function parseTscErrors(output: string): string[]
export function pickTask(input: { failures: string[]; issues: Issue[]; day: number }): Task
export function acceptLane(input: { before: GateRun; after: GateRun; mustClear: boolean }): Verdict
export function mergeBlockers(input: { changed: string[]; dirty: string[]; branch: string }): string[]
export function laneEnv(
  env: Record<string, string | undefined>,
  options?: { copilotHome?: string; token?: string; tmp?: string }
): Record<string, string>
export function copilotArgs(input: { prompt: string; model?: string }): string[]
export function summaryOf(message: string, taskId: string): string
