// Types for the parts of scripts/perf-remote-open.mjs that tests import.

export const FIRST_CARD_SELECTOR: string

export type RequestKind = 'stream' | 'thumb' | 'beacon' | 'request'

export function requestKind(pathOrUrl: string): RequestKind

export function bootCharged<T>(rows: readonly T[], pathOf: (row: T) => string): T[]

export interface RecordedRequest {
  url: string
  type?: string
  /** CDP monotonic seconds. */
  start: number
  end: number | null
  bytes?: number | null
  status?: number | null
}

export interface OpenSummary {
  requests: number
  boot: { measured: boolean; requests: number | null; bytes: number; depth: number; shapes: { shape: string; count: number; bytes: number; ms: number }[] }
  firstCardMs: number | null
  interactiveMs: number | null
  thirdParty: { requests: number; hosts: string[] }
  afterwards: { requests: number; perMinute: number }
}

export function summarise(input: {
  requests: readonly RecordedRequest[]
  navStart: number
  marks: { firstCard?: number | null; fcp?: number | null; dcl?: number | null }
  settleS: number
}): OpenSummary

export function pathShape(url: string): string
export function waterfallDepth(requests: readonly RecordedRequest[]): number
