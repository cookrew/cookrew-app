/**
 * A WORKSPACE TILE'S PAGE THAT WAS NEVER PHOTOGRAPHED (2026-11-16).
 *
 * The workspaces view shows one page of each workspace's fan at a time. A page
 * nobody has opened since its browser was last stopped has no picture anywhere,
 * and thumbnails only ever photograph a page already running, so swiping to it
 * showed the line drawing until the page was opened full screen. Asked here,
 * the page is started once, photographed (the thumb cache keeps the picture on
 * disk), and stopped again unless someone else used it meanwhile.
 *
 * One page at a time, each at most once a launch: a tile asks every poll, and
 * a page that cannot be photographed must not be started again and again.
 */

export interface TileWakeDeps {
  /** A picture is held already (in memory or kept on disk). */
  readonly held: (browserId: string) => boolean
  /** Running or starting: the ordinary thumbnail path photographs it. */
  readonly running: (browserId: string) => boolean
  /** A plain page card this Mac draws: never a computer's screen. */
  readonly wakeable: (browserId: string) => boolean
  readonly start: (browserId: string) => Promise<boolean>
  /** Photograph it now, whatever the age of the held picture. */
  readonly capture: (browserId: string) => Promise<void>
  /** Someone (a viewer, an agent) touched it after `since`. */
  readonly usedSince: (browserId: string, since: number) => boolean
  readonly stop: (browserId: string) => Promise<void>
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** When the page is photographed after starting: a page still loading paints white. */
  readonly shotsAtMs?: readonly number[]
}

const DEFAULT_SHOTS_AT_MS = [3000, 6000] as const
const QUEUE_MAX = 24

export interface TileWake {
  want(ids: readonly string[]): void
  /** Settles when the queue is empty (tests). */
  idle(): Promise<void>
}

export function createTileWake(deps: TileWakeDeps): TileWake {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const shotsAt = deps.shotsAtMs ?? DEFAULT_SHOTS_AT_MS
  const tried = new Set<string>()
  const queue: string[] = []
  let running: Promise<void> | null = null

  const wakeOne = async (id: string): Promise<void> => {
    if (deps.held(id) || deps.running(id) || !deps.wakeable(id)) return
    if (!(await deps.start(id))) return
    const startedAt = now()
    let waited = 0
    for (const at of shotsAt) {
      await sleep(Math.max(0, at - waited))
      waited = at
      await deps.capture(id).catch(() => undefined)
    }
    if (!deps.usedSince(id, startedAt + 1)) await deps.stop(id).catch(() => undefined)
  }

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const id = queue.shift() as string
      await wakeOne(id).catch(() => undefined)
    }
    running = null
  }

  return {
    want(ids) {
      for (const id of ids) {
        if (tried.has(id) || queue.length >= QUEUE_MAX) continue
        if (deps.held(id) || deps.running(id)) continue
        tried.add(id)
        queue.push(id)
      }
      if (!running && queue.length > 0) running = drain()
    },
    idle: () => running ?? Promise.resolve()
  }
}
