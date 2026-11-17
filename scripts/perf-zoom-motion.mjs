/**
 * THE ZOOM VIEW'S MOTION, as a hand makes it: the page-side probes and the
 * gestures the render gates drive. Shared by the CI gate
 * (tests/perf/render-count.perf.ts) and the nightly DOM probe
 * (scripts/perf-dom-probe.mjs), so both measure the same scroll.
 *
 * The canvas these replaced (retired 2026-10-30, 29765969) was panned by a
 * drag on its pane. The zoom view moves by its painter: the wheel scrolls the
 * crew (it never zooms), and the stop bar's buttons zoom between stops. A
 * scroll that moved nothing renders nothing too, so every measured scroll
 * says how far the crew moved, and a caller treats "did not move" as "not
 * measured", never as a pass.
 */

/** The zoom view's middle, where the wheel scrolls; null without a zoom view. */
export const ZOOM_POINT = `(() => {
  const root = document.querySelector('.zv-root')
  if (!root) return null
  const r = root.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`

/** Where the crew's faces are: their tops summed, and how many faces. */
export const CREW_AT = `(() => {
  const faces = [...document.querySelectorAll('.zv-m')]
  return { sum: faces.reduce((sum, el) => sum + el.getBoundingClientRect().top, 0), faces: faces.length }
})()`

/** How far the faces moved between two CREW_AT readings, on average per face (px). */
export const perFaceMove = (from, to) => (to.faces > 0 && from.faces === to.faces ? Math.abs(to.sum - from.sum) / to.faces : 0)

/** The stop the bar marks as here, by its label. */
export const CURRENT_STOP = `(() => document.querySelector('.zv-stops button[aria-current="step"]')?.getAttribute('aria-label') ?? null)()`

/** Press a stop of the bar by its label, as a hand would; false when the bar has none. */
export const CLICK_STOP = (label) => `(() => {
  const b = [...document.querySelectorAll('.zv-stops button')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(label)})
  if (!b) return false
  b.click()
  return true
})()`

/** Frames until `ms` has passed, one rAF at a time. */
export async function framesFor(page, ms) {
  const started = Date.now()
  let n = 0
  while (Date.now() - started < ms) {
    await page.frame()
    n += 1
  }
  return n
}

/**
 * Real wheel ticks down, a rest, and back up. `moved` hears, at the bottom,
 * how far each face had gone on average and how far the wheel asked
 * (ticks x delta): a scroll that took is the first close to the second.
 */
export async function wheelScroll(page, point, ticks, moved = () => undefined, delta = 40) {
  const before = await page.evaluate(CREW_AT)
  for (const dir of [1, -1]) {
    for (let i = 0; i < ticks; i += 1) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: delta * dir })
      await page.frame()
    }
    if (dir === 1) {
      await framesFor(page, 400) // the painter eases to the scroll it was given
      moved({ perFacePx: perFaceMove(before, await page.evaluate(CREW_AT)), requestedPx: ticks * delta })
    }
  }
  return ticks * 2
}

/**
 * Press a stop and let the zoom come to rest, recording it. `travel` says the
 * faces were seen BETWEEN the start and the rest — a zoom that jumped in one
 * frame (reduced motion) could hide per-frame work, and is not a measurement.
 */
export async function zoomTo(page, label, record, settleMs = 1500) {
  let travel = false
  const census = await record(async () => {
    const start = await page.evaluate(CREW_AT)
    if (!(await page.evaluate(CLICK_STOP(label)))) throw new Error(`no '${label}' stop on the bar`)
    let n = 0
    for (let i = 0; i < 4; i += 1, n += 1) await page.frame()
    const mid = await page.evaluate(CREW_AT)
    n += await framesFor(page, settleMs)
    const rest = await page.evaluate(CREW_AT)
    travel = perFaceMove(start, mid) > 0.5 && perFaceMove(mid, rest) > 0.5
    return n
  })
  return { census, travel, landed: await page.evaluate(CURRENT_STOP) }
}
