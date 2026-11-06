// A Dock launch gets the PATH of nobody's shell, so a packaged app has to look
// where installers put things, or it misses herdr and cannot reach its agents.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appendedPath, installerDirs, widenedPath } from '../src/main/launch-defaults'

describe('widenedPath', () => {
  it('finds herdr in ~/.local/bin and tmux in Homebrew from a Dock launch', () => {
    const wide = widenedPath({ PATH: '/usr/bin:/bin' }, '/Users/new', 'darwin').split(':')
    expect(wide).toContain('/Users/new/.local/bin')
    expect(wide).toContain('/opt/homebrew/bin')
  })

  it('keeps the person’s own order first, and adds nothing twice', () => {
    const wide = widenedPath({ PATH: '/opt/homebrew/bin:/usr/bin' }, '/Users/new', 'darwin').split(':')
    expect(wide.slice(0, 2)).toEqual(['/opt/homebrew/bin', '/usr/bin'])
    expect(wide.filter((dir) => dir === '/opt/homebrew/bin')).toHaveLength(1)
  })

  it('leaves Windows alone', () => {
    expect(widenedPath({ PATH: 'C:\\Windows' }, 'C:\\Users\\new', 'win32')).toBe('C:\\Windows')
    expect(installerDirs('C:\\Users\\new', 'win32')).toEqual([])
  })

  it('copes with no PATH at all', () => {
    expect(appendedPath(undefined, ['/a'])).toBe('/a')
  })
})

describe('main', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  it('widens before the terminal host is chosen', () => {
    const widened = source.indexOf('process.env.PATH = widenedPath(process.env, homedir())')
    expect(widened).toBeGreaterThan(0)
    expect(widened).toBeLessThan(source.indexOf('new PtyManager('))
  })

  it('only when packaged: a QA instance stays off the fleet’s host by its narrow PATH', () => {
    expect(source).toMatch(/if \(app\.isPackaged\) \{\s+process\.env\.PATH = widenedPath/)
  })
})
