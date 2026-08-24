import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LatestFileWatcher } from '../src/main/latest-watch'

/**
 * The watcher wraps real fs.watch, so these drive real files. Timing is kept
 * generous (fs events are asynchronous and coalesced) and every watcher is
 * disposed in afterEach so no handle outlives its test.
 */
const dirs: string[] = []
const watchers: LatestFileWatcher[] = []
afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempFile(name = 'session.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'latest-watch-'))
  dirs.push(dir)
  const file = join(dir, name)
  writeFileSync(file, 'seed\n')
  return file
}

/** Resolve on the Nth onChange, or reject after a timeout. */
function counter(): { deps: { onChange: () => void }; waitFor: (n: number, ms?: number) => Promise<number> } {
  let count = 0
  const waiters: { n: number; resolve: (c: number) => void }[] = []
  return {
    deps: {
      onChange: () => {
        count++
        for (const w of waiters.filter((w) => w.n <= count)) w.resolve(count)
      },
    },
    waitFor: (n, ms = 3000) =>
      new Promise((resolve, reject) => {
        if (count >= n) return resolve(count)
        waiters.push({ n, resolve })
        setTimeout(() => reject(new Error(`only ${count}/${n} changes in ${ms}ms`)), ms)
      }),
  }
}

describe('LatestFileWatcher', () => {
  it('fires onChange when the watched file grows', async () => {
    const file = tempFile()
    const c = counter()
    const w = new LatestFileWatcher({ resolveFile: () => file, onChange: c.deps.onChange, debounceMs: 30 })
    watchers.push(w)
    w.subscribe('t1')
    await new Promise((r) => setTimeout(r, 50)) // let the watch arm
    appendFileSync(file, 'turn one\n')
    await expect(c.waitFor(1)).resolves.toBeGreaterThanOrEqual(1)
  })

  it('debounces a burst of appends into fewer pushes', async () => {
    const file = tempFile()
    let count = 0
    const w = new LatestFileWatcher({
      resolveFile: () => file,
      onChange: () => {
        count++
      },
      debounceMs: 80,
    })
    watchers.push(w)
    w.subscribe('t1')
    await new Promise((r) => setTimeout(r, 50))
    for (let i = 0; i < 10; i++) appendFileSync(file, `line ${i}\n`)
    await new Promise((r) => setTimeout(r, 250))
    // 10 rapid appends must collapse to far fewer than 10 pushes.
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThan(5)
  })

  it('refcounts — the file stays watched until the last unsubscribe', async () => {
    const file = tempFile()
    const c = counter()
    const w = new LatestFileWatcher({ resolveFile: () => file, onChange: c.deps.onChange, debounceMs: 30 })
    watchers.push(w)
    w.subscribe('t1')
    w.subscribe('t1') // two viewers of one card's file
    await new Promise((r) => setTimeout(r, 50))
    w.unsubscribe('t1') // one leaves; still one viewer
    appendFileSync(file, 'still watched\n')
    await expect(c.waitFor(1)).resolves.toBeGreaterThanOrEqual(1)
  })

  it('stops firing after the final unsubscribe', async () => {
    const file = tempFile()
    let count = 0
    const w = new LatestFileWatcher({ resolveFile: () => file, onChange: () => void count++, debounceMs: 30 })
    watchers.push(w)
    w.subscribe('t1')
    await new Promise((r) => setTimeout(r, 50))
    w.unsubscribe('t1')
    const at = count
    appendFileSync(file, 'after release\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(count).toBe(at) // no push once released
  })

  it('re-resolves and pushes on rename (rotation)', async () => {
    const file = tempFile()
    const c = counter()
    const w = new LatestFileWatcher({
      resolveFile: () => file,
      onChange: c.deps.onChange,
      debounceMs: 30,
      rearmMs: 60,
    })
    watchers.push(w)
    w.subscribe('t1')
    await new Promise((r) => setTimeout(r, 50))
    // Move the file away then recreate it at the same path (a rotation shape).
    renameSync(file, file + '.old')
    writeFileSync(file, 'rotated\n')
    await new Promise((r) => setTimeout(r, 150)) // let rearm re-watch the new file
    appendFileSync(file, 'post-rotation turn\n')
    await expect(c.waitFor(1)).resolves.toBeGreaterThanOrEqual(1)
  })
})
