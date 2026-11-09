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
  /**
   * THE VERSION: when these PIXELS first arrived. A recapture that returns the
   * same bytes keeps it, so the phone's `known=` matches and the batch answers
   * with a number instead of the frame. It used to move on every capture, and
   * a poll triggers a capture — so an idle page re-sent its 65 KB every five
   * seconds for as long as its card was on screen (relay report, 2026-09-18).
   */
  readonly at: number
  /** When the last capture HAPPENED, for the freshness window — a different fact. */
  readonly capturedAt: number
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
  /** How long an asker waits for a capture before going on with what is held. */
  waitMs?: number
  /** A capture still running after this is let go, so the next ask takes a new one. */
  giveUpMs?: number
}

const DEFAULT_FRESH_MS = 3000
/**
 * A CAPTURE THAT NEVER ENDS (2026-11-01). One headless page whose screenshot
 * never settled held every /api/browser/thumbs batch that named it open
 * forever: the batch awaits the heartbeat of each id. On the companion's six
 * HTTP/1.1 connections, two such batches beside four streams left no room,
 * and the keystrokes typed in LIVE waited behind them. An asker now waits a
 * moment and is answered with the frame held (or none); the capture runs on.
 */
const DEFAULT_WAIT_MS = 1500
const DEFAULT_GIVE_UP_MS = 20_000

const settleAfter = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

export class BrowserThumbCache {
  private readonly frames = new Map<string, ThumbFrame>()
  /** In-flight captures, so N pollers on one browser cost ONE screenshot. */
  private readonly pending = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly freshMs: number
  private readonly waitMs: number
  private readonly giveUpMs: number

  constructor(private readonly deps: ThumbCacheDeps) {
    this.now = deps.now ?? Date.now
    this.freshMs = deps.freshMs ?? DEFAULT_FRESH_MS
    this.waitMs = deps.waitMs ?? DEFAULT_WAIT_MS
    this.giveUpMs = deps.giveUpMs ?? DEFAULT_GIVE_UP_MS
  }

  /** Store a frame pushed as a `data:image/...;base64,...` URL. */
  putDataUrl(browserId: string, dataUrl: string): void {
    const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(dataUrl)
    if (!match) return
    this.put(browserId, match[2], match[1] as ThumbType)
  }

  /**
   * Store a frame pushed as raw base64 of a known type. Identical bytes keep
   * their version: the comparison is one `Buffer.equals`, which is nothing
   * beside the screenshot that produced them.
   */
  put(browserId: string, base64: string, type: ThumbType): void {
    if (base64.length === 0) return
    const data = Buffer.from(base64, 'base64')
    const now = this.now()
    const held = this.frames.get(browserId)
    const same = held !== undefined && held.type === type && held.data.equals(data)
    this.frames.set(browserId, same ? { ...held, capturedAt: now } : { data, type, at: now, capturedAt: now })
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
   *
   * Resolves once the capture lands or after `waitMs`, whichever is first:
   * never later, whatever the page does.
   */
  async refresh(browserId: string, opts: { force?: boolean } = {}): Promise<void> {
    const capture = this.deps.capture
    if (!capture) return
    const existing = this.frames.get(browserId)
    // Forced: something was just done to the page, so the held picture is old whatever its age.
    if (!opts.force && existing && this.now() - existing.capturedAt < this.freshMs) return
    const inFlight = this.pending.get(browserId)
    if (inFlight) return Promise.race([inFlight, settleAfter(this.waitMs)])
    let live = true
    const run = Promise.race([
      capture(browserId).then((base64) => {
        // A capture let go of does not overwrite a newer one's frame.
        if (base64 && live) this.put(browserId, base64, 'image/jpeg')
      }),
      settleAfter(this.giveUpMs).then(() => {
        if (live) console.error(`browser thumbnail capture gave up after ${this.giveUpMs} ms (${browserId})`)
      })
    ])
      .catch((error: unknown) => {
        console.error(`browser thumbnail capture failed (${browserId}):`, error)
      })
      .finally(() => {
        live = false
        if (this.pending.get(browserId) === run) this.pending.delete(browserId)
      })
    this.pending.set(browserId, run)
    return Promise.race([run, settleAfter(this.waitMs)])
  }
}
