import { describe, expect, it } from 'vitest'
import { CURTAIN_MAX_MS, createCurtain, isFullRepaint, subRowShift } from '../src/renderer/src/live-curtain'

// The chunks are the real shapes recorded off the phone page's stream on 2026-10-31.
const REPLAY = '\x1b[2J\x1b[3J\x1b[H\x1b[?1049h\x1b[H  \x1b[38;2;153;153;153mThought\x1b[0m'
const SEED = '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H    history…\x1b]777;cookrew-seed;abc\x07'
const DELTA = '\x1b[?2026h\x1b[?25l\x1b[38;1H\x1b[0;38;2;215;119;87;49m✳\x1b[0m\x1b[?2026l'

function harness(coverable = true) {
  const log: string[] = []
  const frames: Array<() => void> = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const writes: Array<{ chunk: string; done: () => void }> = []
  const curtain = createCurtain({
    cover: () => {
      log.push('cover')
      return coverable
    },
    uncover: () => log.push('uncover'),
    frame: (fn) => frames.push(fn),
    later: (fn, ms) => {
      const t = { fn, ms, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    }
  })
  const write = (chunk: string): void => curtain.write(chunk, (c, done) => writes.push({ chunk: c, done }))
  const runFrames = (): void => {
    while (frames.length > 0) frames.shift()!()
  }
  return { log, frames, timers, writes, write, runFrames, curtain }
}

describe('which chunks repaint the whole screen', () => {
  it('is herdr’s replay and the history seed, never an in-place delta', () => {
    expect(isFullRepaint(REPLAY)).toBe(true)
    expect(isFullRepaint(SEED)).toBe(true)
    expect(isFullRepaint(DELTA)).toBe(false)
  })
})

describe('the curtain holds the painted screen over a full repaint', () => {
  it('writes a delta straight through, with no curtain', () => {
    const h = harness()
    h.write(DELTA)
    expect(h.log).toEqual([])
    expect(h.writes.map((w) => w.chunk)).toEqual([DELTA])
  })

  it('covers before the repaint is written and lifts two frames after it is parsed', () => {
    const h = harness()
    h.write(SEED)
    expect(h.log).toEqual(['cover'])
    h.writes[0].done()
    // Parsed is not painted: the renderer paints on the next frame.
    expect(h.log).toEqual(['cover'])
    expect(h.frames).toHaveLength(1)
    h.frames.shift()!()
    expect(h.log).toEqual(['cover'])
    h.runFrames()
    expect(h.log).toEqual(['cover', 'uncover'])
  })

  it('keeps one curtain across back-to-back repaints and lifts after the last', () => {
    const h = harness()
    h.write(REPLAY)
    h.write(REPLAY)
    h.write(DELTA)
    expect(h.log).toEqual(['cover'])
    h.writes[0].done()
    h.runFrames()
    expect(h.log).toEqual(['cover'])
    h.writes[1].done()
    h.runFrames()
    expect(h.log).toEqual(['cover', 'uncover'])
  })

  it('lifts on its own if a write never reports back', () => {
    const h = harness()
    h.write(SEED)
    const safety = h.timers.filter((t) => t.live)
    expect(safety).toHaveLength(1)
    expect(safety[0].ms).toBe(CURTAIN_MAX_MS)
    safety[0].fn()
    expect(h.log).toEqual(['cover', 'uncover'])
  })

  it('writes as before when there is nothing to copy (a canvas renderer)', () => {
    const h = harness(false)
    h.write(SEED)
    expect(h.writes.map((w) => w.chunk)).toEqual([SEED])
    h.writes[0].done()
    h.runFrames()
    expect(h.log).toEqual(['cover'])
  })
})

describe('the rows follow the finger between two row steps', () => {
  const row = 17
  it('shifts by the pixels left over, against the direction of travel', () => {
    expect(subRowShift({ carry: 7, rowPx: row, atTop: false, atBottom: false })).toBe(-7)
    expect(subRowShift({ carry: -5, rowPx: row, atTop: false, atBottom: false })).toBe(5)
    expect(subRowShift({ carry: 0, rowPx: row, atTop: false, atBottom: false })).toBe(0)
  })

  it('never shifts past an end: nothing below the newest line, nothing above the oldest', () => {
    expect(subRowShift({ carry: 7, rowPx: row, atTop: false, atBottom: true })).toBe(0)
    expect(subRowShift({ carry: -7, rowPx: row, atTop: true, atBottom: false })).toBe(0)
    // the other direction at each end still moves
    expect(subRowShift({ carry: -7, rowPx: row, atTop: false, atBottom: true })).toBe(7)
  })

  it('never shifts more than one row', () => {
    expect(subRowShift({ carry: 40, rowPx: row, atTop: false, atBottom: false })).toBe(-row)
  })
})

describe('the agent’s shared pane is not resized by this viewer for nothing', () => {
  const read = (file: string): string =>
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

  /**
   * Measured on the phone page, 2026-10-31: the terminal's box was 756 px in chat and 787 px in
   * live, because the "is working…" strip sat under the transcript box in the flow. Every switch,
   * and every start or stop of the agent's work while in chat, resized the SHARED pane — a full
   * replay for every viewer, and the live view's history wiped.
   */
  it('floats the chat status strip instead of taking room from the terminal’s box', () => {
    const css = read('transcript-paper.css')
    const rule = css.slice(css.indexOf('.lod-overlay .chat-status {'), css.indexOf('}', css.indexOf('.lod-overlay .chat-status {')))
    expect(rule).toContain('position: absolute')
    expect(rule).not.toContain('flex: 0 0 auto')
  })

  it('sends a size from the refit only when it differs from the pane’s', () => {
    const overlay = read('TerminalOverlay.tsx')
    const observer = overlay.slice(overlay.indexOf('const observer = new ResizeObserver('), overlay.indexOf('observer.observe(container)'))
    expect(observer).toContain('if (paneSize?.cols !== term.cols || paneSize?.rows !== term.rows) sendSize(term.cols, term.rows)')
    // Every resize this viewer makes goes through the tracker.
    const effect = overlay.slice(overlay.indexOf('const fitUntilStable = '), overlay.indexOf('observer.observe(container)'))
    expect(effect).not.toMatch(/cookrew\(\)\.ptyResize\(/)
  })

  it('writes the live stream through the curtain', () => {
    expect(read('TerminalOverlay.tsx')).toContain('curtain.write(detoxify(chunk), (c, done) => term.write(c, done))')
  })
})
