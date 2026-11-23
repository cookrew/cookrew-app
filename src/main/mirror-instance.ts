import type { MirrorPage } from '../shared/dom-mirror'
import { actOnMirror, captureMirror, mirrorSend, pixelProbe, type MirrorCommand } from './dom-mirror'

/**
 * A LIVE TAB, READ AND PRESSED AS A MIRROR (main/mirror-instance.ts).
 *
 * The browser instance hands its active tab here and nothing wider: every CDP
 * call goes through `mirrorSend` (four methods, none of which takes code from
 * the caller), and the only expression evaluated is `pixelProbe`'s own. The
 * agent's `evaluate` is untouched; this adds no CDP surface a viewer can reach.
 */

/** What a mirror needs of one tab: its CDP line, its load events, its own evaluate. */
export interface MirrorTab {
  readonly send: (method: string, params: Record<string, unknown>) => Promise<unknown>
  readonly on: (event: string, listener: (params: Record<string, unknown>) => void) => void
  readonly off: (event: string, listener: (params: Record<string, unknown>) => void) => void
  readonly evaluate: (expression: string) => Promise<unknown>
}

export type MirrorActResult = { ok: true } | { ok: false; why: string }

/** A press lands, the page answers: this long before the fresh read. */
export const MIRROR_SETTLE_MS = 300
/** A press that started loading something waits this long at most for it to stop. */
export const MIRROR_LOAD_WAIT_MS = 6_000

export interface MirrorTiming {
  readonly settleMs: number
  readonly loadWaitMs: number
}

const DEFAULT_TIMING: MirrorTiming = { settleMs: MIRROR_SETTLE_MS, loadWaitMs: MIRROR_LOAD_WAIT_MS }

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The tab as a mirror page, through the narrowed line only. */
export function readMirror(tab: MirrorTab, url: string, title: string): Promise<MirrorPage> {
  return captureMirror({ send: mirrorSend(tab.send), probe: pixelProbe(tab.evaluate) }, url, title)
}

/**
 * One act on one element, then a moment for the page to answer it. A press on
 * a link starts a navigation: the frames that started loading are waited for
 * (up to `loadWaitMs`), so the read that follows is of the page the press led
 * to, not the one it left.
 */
export async function actOnTab(tab: MirrorTab, command: MirrorCommand, timing: MirrorTiming = DEFAULT_TIMING): Promise<MirrorActResult> {
  const loading = new Set<string>()
  let settled: (() => void) | null = null
  const started = (params: Record<string, unknown>): void => {
    if (typeof params.frameId === 'string') loading.add(params.frameId)
  }
  const stopped = (params: Record<string, unknown>): void => {
    if (typeof params.frameId !== 'string') return
    loading.delete(params.frameId)
    if (loading.size === 0) settled?.()
  }
  tab.on('Page.frameStartedLoading', started)
  tab.on('Page.frameStoppedLoading', stopped)
  try {
    const result = await actOnMirror({ send: mirrorSend(tab.send) }, command)
    if (!result.ok) return result
    await wait(timing.settleMs)
    if (loading.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timing.loadWaitMs)
        settled = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    return result
  } finally {
    tab.off('Page.frameStartedLoading', started)
    tab.off('Page.frameStoppedLoading', stopped)
  }
}
