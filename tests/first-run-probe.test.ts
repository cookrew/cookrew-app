import { describe, expect, it, vi } from 'vitest'
import { loginShellDirs, probeTools, type ProbeDeps } from '../src/main/preflight'
import { appendedPath, widenedPath } from '../src/main/launch-defaults'
import { UNKNOWN_FACTS } from '../src/shared/preflight'

/**
 * DETECTION RUNS IN MAIN AND NEVER FAILS LOUDLY. Each check stands alone: one
 * that throws is "unknown", and the rest still answer. Nothing here starts a
 * tool: a file on PATH is the fact, so a probe cannot touch a running herdr.
 */

const deps = (over: Partial<ProbeDeps> = {}): ProbeDeps => ({
  home: '/Users/new',
  pathEnv: '/usr/bin:/bin',
  platform: 'darwin',
  exists: () => false,
  agents: async () => [
    { id: 'claude', installed: false, signedIn: false },
    { id: 'codex', installed: false, signedIn: false }
  ],
  chrome: () => false,
  magpie: () => false,
  host: () => 'direct',
  shellDirs: async () => [],
  ...over
})

describe('the facts', () => {
  it('reads a bare machine as missing, without an error', async () => {
    const facts = await probeTools(deps())
    expect(facts).toMatchObject({ claude: 'missing', codex: 'missing', herdr: 'missing', tmux: 'missing', chrome: 'missing', magpie: 'missing', ollama: 'missing', brew: 'missing', npm: 'missing', host: 'direct', platform: 'darwin' })
  })

  it('finds a tool on PATH by its file', async () => {
    const facts = await probeTools(deps({ exists: (p) => p === '/usr/bin/tmux' || p === '/usr/bin/brew' }))
    expect(facts.tmux).toBe('found')
    expect(facts.brew).toBe('found')
    expect(facts.herdr).toBe('missing')
  })

  it('finds what only the login shell knows: the agents will run there', async () => {
    const facts = await probeTools(deps({ shellDirs: async () => ['/Users/new/.nvm/bin'], exists: (p) => p === '/Users/new/.nvm/bin/npm' }))
    expect(facts.npm).toBe('found')
  })

  // Panes run on the app's PATH, so a tool only the login shell knows would
  // read Found and then fail to start. What the check found, the app takes on.
  it('hands what the login shell added to the app, so a found tool can start', async () => {
    const adoptDirs = vi.fn()
    await probeTools(deps({ shellDirs: async () => ['/Users/new/.nvm/bin'], adoptDirs }))
    expect(adoptDirs).toHaveBeenCalledWith(['/Users/new/.nvm/bin'])
  })

  it('still answers when the login shell cannot be read', async () => {
    const facts = await probeTools(deps({ shellDirs: async () => { throw new Error('no shell') }, exists: (p) => p === '/usr/bin/tmux' }))
    expect(facts.tmux).toBe('found')
  })

  it('finds the Ollama app without its command line', async () => {
    expect((await probeTools(deps({ exists: (p) => p === '/Applications/Ollama.app' }))).ollama).toBe('found')
  })

  it('carries the sign-in only for an agent tool that is there', async () => {
    const facts = await probeTools(deps({ agents: async () => [{ id: 'claude', installed: true, signedIn: false }, { id: 'codex', installed: false, signedIn: false }] }))
    expect(facts.claude).toBe('found')
    expect(facts.claudeSignedIn).toBe(false)
    expect(facts.codex).toBe('missing')
    expect(facts.codexSignedIn).toBeNull()
  })
})

describe('a check that fails', () => {
  it('is unknown, alone', async () => {
    const facts = await probeTools(deps({ chrome: () => { throw new Error('no') }, exists: (p) => p === '/usr/bin/tmux' }))
    expect(facts.chrome).toBe('unknown')
    expect(facts.tmux).toBe('found')
  })

  it('makes both agent tools unknown when the scan fails, not missing', async () => {
    const facts = await probeTools(deps({ agents: async () => { throw new Error('no') } }))
    expect(facts.claude).toBe('unknown')
    expect(facts.codex).toBe('unknown')
  })

  it('reads the file checks as unknown when the disk throws', async () => {
    const facts = await probeTools(deps({ exists: () => { throw new Error('EPERM') } }))
    expect(facts.herdr).toBe('unknown')
    expect(facts.tmux).toBe('unknown')
    expect(facts.brew).toBe('unknown')
    expect(facts.ollama).toBe('unknown')
  })

  it('leaves the host unread rather than guessing it', async () => {
    expect((await probeTools(deps({ host: () => { throw new Error('no') } }))).host).toBeNull()
  })

  it('answers all-unknown when the whole probe outlives its budget', async () => {
    const facts = await probeTools(deps({ agents: () => new Promise(() => undefined) }), 10)
    expect(facts).toEqual(UNKNOWN_FACTS)
  })
})

describe('the login shell’s PATH', () => {
  it('reads the marked line and ignores what the rc files print around it', () => {
    expect(loginShellDirs('Welcome!\n__COOKREW_PATH__/a:/b:\nbye\n')).toEqual(['/a', '/b'])
  })

  it('is nothing when the mark is absent', () => {
    expect(loginShellDirs('no mark here')).toEqual([])
  })
})

describe('a Dock launch gets the same tools as a terminal launch', () => {
  it('appends the places installers use, the person’s own PATH first', () => {
    const wide = widenedPath({ PATH: '/usr/bin:/bin' }, '/Users/new')
    expect(wide.split(':').slice(0, 2)).toEqual(['/usr/bin', '/bin'])
    expect(wide.split(':')).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/usr/local/bin', '/Users/new/.local/bin']))
  })

  it('adds nothing twice, so a terminal launch keeps its PATH as it is', () => {
    const full = '/opt/homebrew/bin:/usr/local/bin:/Users/new/.local/bin:/Users/new/.claude/local:/usr/bin:/bin'
    expect(widenedPath({ PATH: full }, '/Users/new')).toBe(full)
  })

  it('leaves another system’s PATH alone', () => {
    expect(widenedPath({ PATH: 'C:\\Windows' }, 'C:\\Users\\new', 'win32')).toBe('C:\\Windows')
  })

  it('keeps the PATH it was given to the character, whatever it adds', () => {
    expect(widenedPath({ PATH: '/usr/bin::/bin' }, '/Users/new').startsWith('/usr/bin::/bin:')).toBe(true)
  })

  it('appends dirs not already there, and nothing else', () => {
    expect(appendedPath('/a:/b', ['/b', '/c', ''])).toBe('/a:/b:/c')
    expect(appendedPath(undefined, ['/c'])).toBe('/c')
    expect(appendedPath('/a', [])).toBe('/a')
  })

  it('works from no PATH at all', () => {
    expect(widenedPath({}, '/Users/new').split(':')).toContain('/opt/homebrew/bin')
  })
})
