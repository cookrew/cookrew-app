import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * IPC channel names are strings, so nothing in the type system stops two
 * handlers claiming one channel or a preload method invoking the wrong one.
 * Both happened: `preset:list` was registered twice — Electron THROWS on the
 * second registration, and because the block has no try/catch it took every
 * handler after it with it — while the preload aliased two different methods
 * onto that same channel, so the survivor returned the wrong shape entirely.
 *
 * Neither typecheck nor any unit test could see it, because the failure lives
 * in agreement between two files and only shows when Electron boots. These
 * checks read the source instead, so the same class of mistake fails in
 * `npm test` rather than at runtime on someone's canvas.
 */

const root = path.join(__dirname, '..')
const preloadSrc = readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')

const matchAll = (src: string, re: RegExp): string[] =>
  [...src.matchAll(re)].map((m) => m[1])

/**
 * Registrations across the WHOLE main tree, not just index.ts. Two forms count:
 * `ipcMain.handle('x')` directly, and `handle('x')` inside a module that was
 * given ipcMain.handle as a parameter — restore.ts registers that way, and a
 * scrape that missed it would have called its channels orphans.
 *
 * Scanning every file is also what makes the duplicate check meaningful: the
 * same channel claimed from two different modules fails exactly the same way as
 * two claims in one file.
 */
function mainSources(): string[] {
  const dir = path.join(root, 'src/main')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
}

const handled = (): string[] =>
  mainSources().flatMap((src) => [
    ...matchAll(src, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g),
    ...matchAll(src, /(?<!\.)\bhandle\(\s*['"]([^'"]+)['"]/g)
  ])

const invoked = (): string[] => matchAll(preloadSrc, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)

describe('ipcMain channels are registered exactly once', () => {
  it('has no duplicate handler registration', () => {
    const seen = new Map<string, number>()
    for (const channel of handled()) seen.set(channel, (seen.get(channel) ?? 0) + 1)
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c, n]) => `${c} (${n}x)`)
    // Electron throws "Attempted to register a second handler for <channel>",
    // and the throw kills every registration that follows it in the block.
    expect(duplicates).toEqual([])
  })

  it('registers a non-trivial number of channels — the scrape still works', () => {
    // Guards the test itself: a regex that silently stops matching would make
    // the duplicate check vacuously pass forever.
    expect(handled().length).toBeGreaterThan(30)
  })
})

describe('every preload invoke has a main handler', () => {
  it('names no channel that main does not register', () => {
    const registered = new Set(handled())
    const orphans = [...new Set(invoked())].filter((c) => !registered.has(c))
    expect(orphans).toEqual([])
  })

  it('scrapes a non-trivial number of invokes', () => {
    expect(invoked().length).toBeGreaterThan(30)
  })
})

describe('the harness preset list keeps its own channel', () => {
  it('keeps preset:list for harness presets only', () => {
    expect(handled().filter((c) => c === 'preset:list')).toHaveLength(1)
  })

  // The installed-marketplace namespace (preset:installed:*) was removed with
  // the lane it served — the store it read had no way to install anything and
  // the three chips on it were a QA fixture on disk. What this now guards is
  // that nothing reintroduces a SECOND meaning for preset:list: the aliasing
  // bug it was written for made one method return the other list's rows.
  it('never points two preload methods at preset:list', () => {
    const listChannels = matchAll(
      preloadSrc,
      /(\w+):\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]preset:list['"]/g
    )
    expect(listChannels).toHaveLength(1)
  })
})
