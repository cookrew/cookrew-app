// Types for scripts/perf-zoom-motion.mjs.
import type { CdpPage, FrameCensus } from './perf-dom-probe.mjs'

export const ZOOM_POINT: string
export const CREW_AT: string
export interface CrewAt {
  sum: number
  faces: number
}
export function perFaceMove(from: CrewAt, to: CrewAt): number
export const CURRENT_STOP: string
export function CLICK_STOP(label: string): string
export function framesFor(page: CdpPage, ms: number): Promise<number>
export interface ScrollMoved {
  /** How far the faces moved, on average per face, at the bottom of the scroll. */
  perFacePx: number
  /** How far the wheel asked: ticks x delta. */
  requestedPx: number
}
export function wheelScroll(page: CdpPage, point: { x: number; y: number }, ticks: number, moved?: (m: ScrollMoved) => void, delta?: number): Promise<number>

export interface ZoomLeg {
  census: FrameCensus
  /** The faces were seen moving between the press and the rest. */
  travel: boolean
  /** The bar's stop once the leg was over. */
  landed: string | null
}

export function zoomTo(page: CdpPage, label: string, record: (run: () => Promise<number>) => Promise<FrameCensus>, settleMs?: number): Promise<ZoomLeg>
