import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE BOOT ORDER, READ FROM THE SOURCE. index.ts cannot be imported into a test
 * (it is the Electron entry), and the first version of this feature passed
 * every unit test and would have shown nobody anything: the Conductor was
 * seeded at boot, so the first read always found a card and closed the run.
 * These hold the three lines that make a real launch behave.
 */

const source = readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
const body = (name: string): string => {
  const at = source.indexOf(`function ${name}(`)
  return source.slice(at, source.indexOf('\n}\n', at))
}

describe('a real launch', () => {
  it('asks the first run before seeding a Conductor, whichever path seeds one', () => {
    expect(body('seedConductorIfEmpty')).toMatch(/conductorWaits\(firstRunStore\.read\(\)\)/)
    expect(body('seedConductorIfEmpty').indexOf('conductorWaits')).toBeLessThan(body('seedConductorIfEmpty').indexOf('store.addNode'))
  })

  it('decides who is new from the install, not only from what is on the board', () => {
    expect(source).toMatch(/hasContent: \(\) => !store\.freshInstall \|\| store\.hasContent\(\)/)
  })

  it('widens PATH for a packaged app only: a terminal launch keeps the PATH its person chose', () => {
    const writes = [...source.matchAll(/process\.env\.PATH = /g)].map((m) => m.index)
    expect(writes.length).toBeGreaterThan(0)
    for (const at of writes) expect(source.slice(Math.max(0, at - 90), at)).toMatch(/if \(app\.isPackaged\)/)
  })

  // A new Claude asks about a new folder in a dialog the prompt box cannot draw
  // (its rows have no numbers), so the person would wait behind it unseen.
  it('trusts the chosen folder for the first task alone, before the agent starts', () => {
    const create = body('createTerminal')
    expect(create).toMatch(/opts\.patient === true && isClaudeCommand\(terminal\.command\)\) trustDirectory\(terminal\.cwd/)
    expect(create.indexOf('trustDirectory(')).toBeLessThan(create.indexOf('spawnTracked('))
  })

  it('sets PATH before the terminal host is chosen', () => {
    expect(source.indexOf('widenedPath(process.env')).toBeLessThan(source.indexOf('new PtyManager('))
  })
})
