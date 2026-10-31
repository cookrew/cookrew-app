import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * THE SIZE A PANE HAD, SO ITS MIRROR STARTS AT IT.
 *
 * A terminal's mirror (PtySession) attaches to herdr as a client, and herdr
 * sizes the pane to it: started at the default 100x30, every attach shrank
 * the shared pane to 100x30 under whoever was watching (measured 2026-11-01:
 * opening Tinker's full view from a viewer that did not take the size took
 * the pane from 208x52 to 100x30, and it stayed there). herdr's own layout
 * does not know the real size (it answered 120x40 for that pane).
 *
 * So the last size applied to each terminal is kept here, on disk to outlive
 * a restart, and a new mirror starts at it. Writes are batched and atomic.
 */
export interface PaneSize {
  cols: number
  rows: number
}

export const PANE_SIZES_MAX = 1000
const WRITE_DELAY_MS = 1000

const valid = (v: unknown): v is PaneSize =>
  typeof v === 'object' && v !== null &&
  Number.isInteger((v as PaneSize).cols) && Number.isInteger((v as PaneSize).rows) &&
  (v as PaneSize).cols >= 10 && (v as PaneSize).cols <= 1000 && (v as PaneSize).rows >= 4 && (v as PaneSize).rows <= 500

export function createPaneSizes(file: string, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  let sizes: Map<string, PaneSize> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const load = (): Map<string, PaneSize> => {
    if (sizes) return sizes
    sizes = new Map()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [id, size] of Object.entries(raw)) if (valid(size)) sizes.set(id, { cols: size.cols, rows: size.rows })
    } catch {
      // No file yet, or not ours to read: start empty.
    }
    return sizes
  }

  const write = (): void => {
    timer = null
    const all = load()
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(all)))
      renameSync(tmp, file)
    } catch (error) {
      console.error('pane sizes: could not save:', error)
    }
  }

  return {
    get(id: string): PaneSize | null {
      return load().get(id) ?? null
    },
    remember(id: string, size: PaneSize): void {
      if (!valid(size)) return
      const all = load()
      const known = all.get(id)
      if (known && known.cols === size.cols && known.rows === size.rows) return
      all.delete(id)
      all.set(id, { cols: size.cols, rows: size.rows })
      while (all.size > PANE_SIZES_MAX) {
        const oldest = all.keys().next().value
        if (oldest === undefined) break
        all.delete(oldest)
      }
      if (timer === null) timer = timers.set(write, WRITE_DELAY_MS)
    },
    /** Write now (app quit). */
    flush(): void {
      if (timer !== null) {
        timers.clear(timer)
        write()
      }
    }
  }
}
