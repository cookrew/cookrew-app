// The latest picture of each browser card, and who is allowed to take it.
//
// Two producers push frames here: the legacy renderer capture loop (flag off,
// PNG data URLs over IPC) and the headless page itself (flag on, base64 JPEG
// from CDP). One consumer reads them — the phone's /api/browser/:id/thumb.
//
// With the flag ON that consumer used to depend on the DESKTOP renderer
// running its snapshot loop: main only ever held what the renderer chose to
// push, so a phone looking at the canvas while the desktop was hidden (or at a
// card the desktop had zoomed, which the loop skips) saw placeholders on every
// browser. Main can take the picture itself — it owns the headless instances —
// so the cache captures on demand, and a TTL keeps a poll per browser every
// few seconds from turning into a CDP screenshot per browser per request.

import { Buffer } from 'node:buffer'

export type ThumbType = 'image/png' | 'image/jpeg'

export interface ThumbFrame {
  readonly data: Buffer
  readonly type: ThumbType
  /** When the frame was stored, for the freshness window. */
  readonly at: number
}

export interface ThumbCacheDeps {
  /**
   * A still of the headless page as base64, or null when there is no running
   * instance (never a reason to launch one) and when the capture fails.
   */
  capture?: (browserId: string) => Promise<string | null>
  now?: () => number
  /** A frame younger than this is served as-is. Default 3s. */
  freshMs?: number
}

const DEFAULT_FRESH_MS = 3000

export class BrowserThumbCache {
  private readonly frames = new Map<string, ThumbFrame>()
  /** In-flight captures, so N pollers on one browser cost ONE screenshot. */
  private readonly pending = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly freshMs: number

  constructor(private readonly deps: ThumbCacheDeps) {
    this.now = deps.now ?? Date.now
    this.freshMs = deps.freshMs ?? DEFAULT_FRESH_MS
  }

  /** Store a frame pushed as a `data:image/...;base64,...` URL. */
  putDataUrl(browserId: string, dataUrl: string): void {
    const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(dataUrl)
    if (!match) return
    this.put(browserId, match[2], match[1] as ThumbType)
  }

  /** Store a frame pushed as raw base64 of a known type. */
  put(browserId: string, base64: string, type: ThumbType): void {
    if (base64.length === 0) return
    this.frames.set(browserId, { data: Buffer.from(base64, 'base64'), type, at: this.now() })
  }

  frame(browserId: string): ThumbFrame | undefined {
    return this.frames.get(browserId)
  }

  /** The frame as a data URL, for the renderer's `<img src>`. */
  dataUrl(browserId: string): string | null {
    const frame = this.frames.get(browserId)
    return frame ? `data:${frame.type};base64,${frame.data.toString('base64')}` : null
  }

  forget(browserId: string): void {
    this.frames.delete(browserId)
  }

  /**
   * Make sure a recent frame exists, taking one from the headless page if the
   * cached one has aged out. A failed or impossible capture LEAVES the last
   * frame in place: a card that briefly cannot be photographed should keep
   * showing the page it was on, not fall back to the empty placeholder.
   */
  async refresh(browserId: string): Promise<void> {
    const capture = this.deps.capture
    if (!capture) return
    const existing = this.frames.get(browserId)
    if (existing && this.now() - existing.at < this.freshMs) return
    const inFlight = this.pending.get(browserId)
    if (inFlight) return inFlight
    const run = capture(browserId)
      .then((base64) => {
        if (base64) this.put(browserId, base64, 'image/jpeg')
      })
      .catch((error: unknown) => {
        console.error(`browser thumbnail capture failed (${browserId}):`, error)
      })
      .finally(() => {
        this.pending.delete(browserId)
      })
    this.pending.set(browserId, run)
    return run
  }
}
