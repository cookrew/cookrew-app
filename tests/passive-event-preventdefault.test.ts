// React registers `wheel`, `touchstart` and `touchmove` on its root container
// as PASSIVE listeners. Calling preventDefault() from an onWheel/onTouch* prop
// is therefore silently ignored, and logs
//
//     Unable to preventDefault inside passive event listener invocation.
//
// once per event. MobileBrowserFrame's onWheel did exactly this: it forwards
// scroll to the remote page and tried to stop the local surface scrolling too,
// and that second half had never once worked. A wheel of the mouse produced a
// column of warnings and no prevented default.
//
// The fix is addEventListener('wheel', handler, { passive: false }) on a ref.
//
// This is a SOURCE rule, not a runtime test — the repo has no jsdom, so nothing
// here can actually dispatch an event and watch defaultPrevented. It catches
// reintroduction of the pattern, which is the failure mode that matters.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'src')

/** Event types React attaches passively; preventDefault cannot work in them. */
const PASSIVE_EVENT_TYPES = /React\.(Wheel|Touch)Event/g

/** How far past the handler signature to look for the offending call. */
const HANDLER_WINDOW = 500

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Handlers typed for a passive event that try to preventDefault. */
function offenders(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const hits: string[] = []
  for (const match of source.matchAll(PASSIVE_EVENT_TYPES)) {
    const from = match.index ?? 0
    if (source.slice(from, from + HANDLER_WINDOW).includes('preventDefault')) {
      hits.push(`${path.relative(RENDERER, file)} — ${match[0]}`)
    }
  }
  return hits
}

describe('preventDefault is never called on a passively-registered React event', () => {
  it('finds no React wheel/touch handler calling preventDefault', () => {
    const found = sourceFiles(RENDERER).flatMap(offenders)
    expect(found).toEqual([])
  })

  it('the detector actually detects — it is not vacuously passing', () => {
    // A rule test that cannot fail is worse than no rule test. Two guards: the
    // scan reaches real files, and the pattern it looks for is one it would
    // genuinely flag.
    const files = sourceFiles(RENDERER)
    expect(files.length).toBeGreaterThan(20)

    const sample = `const onWheel = (e: React.WheelEvent): void => { e.preventDefault() }`
    const from = sample.search(PASSIVE_EVENT_TYPES)
    expect(from).toBeGreaterThan(-1)
    expect(sample.slice(from, from + HANDLER_WINDOW)).toContain('preventDefault')
  })
})
