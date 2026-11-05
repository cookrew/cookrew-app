import { afterEach, describe, expect, it } from 'vitest'
import { addPaneDirs, installerDirs, paneDirs, panePath, resetPaneDirs } from '../src/main/pane-path'
import { paneEnv } from '../src/main/pane-env'
import { probeTools, type ProbeDeps } from '../src/main/preflight'

/**
 * ONE PATH (round 2, bug 3). The check said Found and the first agent died:
 * the check read the login shell's PATH, panes got the app's. Now both ask
 * panePath(), so what the check trusts is what a pane is given, in a source
 * build too. process.env.PATH itself is left alone outside a packaged app:
 * it is what picks the terminal host, and a QA instance's PATH without herdr
 * is what keeps it off the fleet.
 */

afterEach(() => resetPaneDirs())

describe('the PATH panes get', () => {
  it('is the app’s PATH to the character, then the dirs added to it', () => {
    addPaneDirs(['/Users/new/.nvm/bin'])
    expect(panePath('/usr/bin::/bin')).toBe('/usr/bin::/bin:/Users/new/.nvm/bin')
  })

  it('adds nothing twice', () => {
    addPaneDirs(['/a', '/a', '/usr/bin'])
    addPaneDirs(['/a'])
    expect(panePath('/usr/bin')).toBe('/usr/bin:/a')
  })

  it('leaves process.env.PATH alone: the host is chosen from that', () => {
    const before = process.env.PATH
    addPaneDirs(['/somewhere/new'])
    expect(process.env.PATH).toBe(before)
    expect(panePath()).toContain('/somewhere/new')
  })

  it('refuses a dir that could break out of the quoted export it lands in', () => {
    addPaneDirs(["/a'; rm -rf ~; '", '/b\nc', 'relative/bin', '/c:/d', ''])
    expect(paneDirs()).toEqual([])
  })

  it('names the places installers use, for a Mac and for Linux', () => {
    expect(installerDirs('/home/new', 'linux')).toEqual(expect.arrayContaining(['/home/new/.local/bin', '/home/new/.claude/local', '/usr/local/bin']))
    expect(installerDirs('C:\\Users\\new', 'win32')).toEqual([])
  })

  it('is what a pane’s environment carries', () => {
    addPaneDirs(['/home/new/.local/bin'])
    const env = paneEnv({ terminalId: 't', socketPath: '/s', cliDir: '/cli', ownerEnv: { PATH: panePath('/usr/bin') } })
    expect(env.PATH).toBe('/cli:/usr/bin:/home/new/.local/bin')
  })
})

describe('what the check reads', () => {
  const deps = (over: Partial<ProbeDeps> = {}): ProbeDeps => ({
    home: '/home/new',
    panePath: () => panePath('/usr/bin'),
    adoptDirs: addPaneDirs,
    platform: 'linux',
    exists: () => false,
    agents: async () => [],
    chrome: () => false,
    magpie: () => false,
    host: () => 'tmux',
    shellDirs: async () => [],
    ...over
  })

  it('finds a tool only where a pane would: what the login shell knows is adopted first', async () => {
    const facts = await probeTools(deps({ shellDirs: async () => ['/home/new/.nvm/bin'], exists: (p) => p === '/home/new/.nvm/bin/npm' }))
    expect(facts.npm).toBe('found')
    expect(panePath('/usr/bin')).toContain('/home/new/.nvm/bin')
  })

  it('does not say Found for a dir panes were not given', async () => {
    const facts = await probeTools(deps({ adoptDirs: () => undefined, shellDirs: async () => ['/home/new/.nvm/bin'], exists: (p) => p === '/home/new/.nvm/bin/npm' }))
    expect(facts.npm).toBe('missing')
  })

  it('hands the agent scan that same PATH', async () => {
    const asked: string[] = []
    await probeTools(deps({ shellDirs: async () => ['/x/bin'], agents: async (p) => (asked.push(p), []) }))
    expect(asked).toEqual([panePath('/usr/bin')])
  })
})
