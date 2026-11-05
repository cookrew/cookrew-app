import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { brushPath, type MarkName } from '../src/renderer/src/zoom/ink-marks'

/**
 * THE FACE ON THE WRIST IS THE FACE ON THE MAC. The Swift port of the brush
 * (watch/Sources/CookrewCore/InkMarks.swift) is held to these strokes by its
 * own test; this one keeps the fixture honest when the brush here changes.
 */
const CASES: { mark: MarkName; width: number; seed: number; dry?: number }[] = [
  { mark: 'enso', width: 4.6, seed: 9 },
  { mark: 'ensoClosed', width: 4.6, seed: 20 },
  { mark: 'claude', width: 6.2, seed: 9 },
  { mark: 'codex', width: 6.2, seed: 13 },
  { mark: 'opencode', width: 6.2, seed: 6 },
  { mark: 'pi', width: 6.2, seed: 27 },
  { mark: 'shell', width: 6.2, seed: 5 },
  { mark: 'ringWorking', width: 6.048, seed: 9, dry: 0.42 },
  { mark: 'ringWaiting', width: 6.832, seed: 9, dry: 0.08 },
  { mark: 'tick', width: 7, seed: 9, dry: 0.28 },
  { mark: 'zee', width: 4.3, seed: 9, dry: 0.12 }
]

const points = (d: string): number[][] =>
  (d.match(/-?\d+\.\d+ -?\d+\.\d+/g) ?? []).map((pair) => pair.split(' ').map(Number))

describe('the ink fixture', () => {
  it('is what the brush draws now', () => {
    const strokes = CASES.map((c) => {
      const paths = brushPath(c.mark, { width: c.width, seed: c.seed, ...(c.dry === undefined ? {} : { dry: c.dry }) })
      return { ...c, dry: c.dry ?? 0.22, body: points(paths.body), bristles: points(paths.bristles).length, drop: paths.drop }
    })
    const file = path.join(__dirname, '..', 'watch', 'Fixtures', 'ink-marks.json')
    const body = `${JSON.stringify(strokes)}\n`
    if (!existsSync(file) || process.env.UPDATE_WATCH_FIXTURE === '1') writeFileSync(file, body)
    expect(readFileSync(file, 'utf8')).toBe(body)
  })
})
