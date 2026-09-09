/**
 * Types for scripts/perf-dom-probe.mjs, so tests/perf/render-count.perf.ts
 * type-checks under tsconfig.node.json. The implementation stays plain JS
 * because launchd runs a copy of it beside perf-eval.mjs with no checkout
 * behind it.
 */

export interface Viewport {
  width: number
  height: number
  mobile: boolean
}

export const VIEWPORTS: Record<'phone' | 'desktop', Viewport>

export function findChrome(): string | null

export interface Chrome {
  port: number
  kill: () => Promise<void>
}

export function launchChrome(options: { width: number; height: number; chrome?: string | null }): Promise<Chrome>

export interface CdpPage {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  on: (method: string, cb: (params: Record<string, unknown>) => void) => () => void
  evaluate: <T = unknown>(expression: string) => Promise<T>
  frame: () => Promise<number>
  close: () => void
}

export function connectPage(port: number): Promise<CdpPage>

export const HOOK_SCRIPT: string
export const CENSUS: string
export const FIBER_CENSUS: string
export const PANE_POINT: string

export interface FrameCensus {
  frames: number
  commits: number
  commitsPerFrame: number
  renders: Record<string, number>
  /** Node ids whose card wrapper rendered. */
  cards: string[]
}

export function recordFrames(page: CdpPage, run: () => Promise<number>): Promise<FrameCensus>
export function pan(page: CdpPage, point: { x: number; y: number }, frames: number, step?: number): Promise<number>
export function zoom(page: CdpPage, point: { x: number; y: number }, frames: number, delta?: number): Promise<number>
export function waitForCanvas(page: CdpPage, timeoutMs?: number, settleMs?: number): Promise<number>

export interface MeasureOptions {
  viewport: string
  size: Viewport
  url: string
  apiPort: number
  token: string
  frames: number
  gestures: boolean
  serve: string | null
  served: Served | null
  settleMs?: number
}

export function measureCompanion(
  chrome: { port: number },
  options: MeasureOptions,
  connect?: (port: number) => Promise<CdpPage>
): Promise<Record<string, unknown>>

export interface Served {
  port: number
  close: () => void
}

export function serveBuild(dir: string, apiPort: number | null, options?: { remote?: boolean }): Promise<Served>

export function readToken(base?: string): string | null

export function probeCompanion(options?: {
  viewport?: 'phone' | 'desktop'
  apiPort?: number
  serve?: string | null
  frames?: number
  gestures?: boolean
  token?: string | null
  timeoutMs?: number
  settleMs?: number
}): Promise<Record<string, unknown>>

export function probeAttached(port: number): Promise<Record<string, unknown>>
export function renderReport(result: Record<string, unknown>): string
