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

describe('the harness and marketplace preset lists stay separate channels', () => {
  it('keeps preset:list for harness presets only', () => {
    expect(handled().filter((c) => c === 'preset:list')).toHaveLength(1)
  })

  it('gives installed marketplace presets their own namespace', () => {
    for (const channel of [
      'preset:installed:list',
      'preset:installed:place',
      'preset:installed:uninstall',
      // R20's two decisions, deliberately separate: reading the rotation sheet
      // is not accepting the key it describes.
      'preset:installed:rotation:seen',
      'preset:installed:rotation:trust'
    ]) {
      expect(handled()).toContain(channel)
    }
  })

  it('does not let the preload point two methods at one channel', () => {
    // The specific aliasing bug: listPresets and listInstalledPresets both
    // invoked preset:list, so the marketplace method returned harness rows.
    const listChannels = matchAll(
      preloadSrc,
      /(?:listPresets|listInstalledPresets):\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g
    )
    expect(listChannels).toHaveLength(2)
    expect(new Set(listChannels).size).toBe(2)
  })
})
