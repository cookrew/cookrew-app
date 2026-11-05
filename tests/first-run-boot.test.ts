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
  // What it decides is tested for real in first-run-seed.test.ts; this holds the wiring.
  it('has one way to seed a Conductor, told the first run and the panes’ PATH', () => {
    expect(body('seedConductorIfEmpty')).toMatch(/seedConductor\(\{ store, stage: \(\) => firstRunStore\.read\(\), searchPath: paneSearchPath \}, workspaceId\)/)
    expect(source).toMatch(/openWorkspace\(store, \{ name, dir, stay: options\.stay === true, seed: seedConductorIfEmpty \}\)/)
    expect(source).not.toMatch(/name: 'Conductor'/)
  })

  it('decides who is new from the install, not only from what is on the board', () => {
    expect(source).toMatch(/hasContent: \(\) => !store\.freshInstall \|\| store\.hasContent\(\)/)
  })

  it('widens PATH for a packaged app only: a terminal launch keeps the PATH its person chose', () => {
    const writes = [...source.matchAll(/process\.env\.PATH = /g)].map((m) => m.index)
    expect(writes.length).toBeGreaterThan(0)
    for (const at of writes) expect(source.slice(Math.max(0, at - 90), at)).toMatch(/if \(app\.isPackaged\)/)
  })

  // The read races the boot's seed, so what it learns has to outlast this launch:
  // a tool only the login shell can see would otherwise never get its Conductor.
  it('keeps what a packaged app reads from the login shell', () => {
    expect(source).toMatch(/readLoginShellDirs\(\)\.then\(\(dirs\) => \{\n\s+addPaneDirs\(dirs\)\n\s+firstRunStore\.rememberDirs\(dirs\)/)
  })

  // A new Claude asks about a new folder in a dialog the prompt box cannot draw
  // (its rows have no numbers), so the person would wait behind it unseen.
  it('trusts the chosen folder for the first task alone, before the agent starts', () => {
    const create = body('createTerminal')
    expect(create).toMatch(/opts\.patient === true && isClaudeCommand\(terminal\.command\)\) trustDirectory\(realDir\(terminal\.cwd\)/)
    expect(create.indexOf('trustDirectory(')).toBeLessThan(create.indexOf('spawnTracked('))
  })

  it('gives panes the installers’ dirs in every build, outside the packaged branch', () => {
    const at = source.indexOf('addPaneDirs(installerDirs(homedir()))')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(source.indexOf('if (app.isPackaged) {'))
  })

  // Merged from Agent Truth with process.env.PATH, it would have refused on a source
  // build the very agent the tool check calls Found: bug 3 over again.
  it('has one PATH: the launch check looks where a pane will', () => {
    expect(source).toMatch(/const paneSearchPath = \(\): string => `\$\{ptys\.runtimeDir\}:\$\{panePath\(\)\}`/)
  })

  it('asks the launch check whether a tool is here, on every backend', () => {
    expect(body('toolBlockOf')).toMatch(/checkCommand: true/)
    expect(source).toMatch(/const block = toolBlockOf\(found\.command, store\.focusedState\.dir\)/)
    expect(source).toMatch(/failure: \(id\) => agents\.lookup\(id\)\?\.failure \?\? null/)
  })

  it('holds a first task instead of typing it, and only a first task', () => {
    expect(body('createTerminal')).toMatch(/if \(opts\.patient === true && first\) firstTasks\.hold\(/)
    expect(body('createTerminal')).toMatch(/injectWhenReady\(session, boot\)/)
  })

  it('keeps a stranger’s seat off the owner’s endpoint', () => {
    expect(source).toMatch(/!served && route\?\.effective === 'direct' \? accessStore\.launchFor/)
  })

  it('tells the first task a card went only once it has: a close can fail', () => {
    const remove = body('removeNode')
    expect(remove.indexOf('firstTasks.cardGone(id)')).toBeGreaterThan(remove.indexOf('store.removeNodeAcross(id)'))
  })

  it('sets PATH before the terminal host is chosen', () => {
    expect(source.indexOf('widenedPath(process.env')).toBeLessThan(source.indexOf('new PtyManager('))
  })
})
