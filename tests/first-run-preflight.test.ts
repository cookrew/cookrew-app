import { describe, expect, it } from 'vitest'
import { HARNESS_FACTS, INSTALL_LINE } from '../src/main/route/setup'
import { setupLineAllowed } from '../src/shared/route-lines'
import { TOOL_NOTES } from '../src/shared/first-run-copy'
import { UNKNOWN_FACTS, mayContinue, preflightRows, type PreflightRow, type ToolFacts, type ToolState } from '../src/shared/preflight'
import { XDOTOOL_INSTALL } from '../src/shared/remote-access'

/**
 * ONE CALM ROW PER TOOL. A row is found, or it says what is missing and holds
 * the one line that fixes it; a check that failed is "unknown" and never
 * stands in anybody's way.
 */

const allFound: ToolFacts = {
  claude: 'found',
  claudeSignedIn: true,
  codex: 'found',
  codexSignedIn: true,
  pi: 'found',
  opencode: 'found',
  herdr: 'found',
  tmux: 'found',
  chrome: 'found',
  magpie: 'found',
  ollama: 'found',
  brew: 'found',
  npm: 'found',
  host: 'herdr',
  platform: 'darwin',
  arch: 'arm64'
}
const bareMac: ToolFacts = {
  ...allFound,
  claude: 'missing',
  claudeSignedIn: null,
  codex: 'missing',
  codexSignedIn: null,
  pi: 'missing',
  opencode: 'missing',
  herdr: 'missing',
  tmux: 'missing',
  chrome: 'missing',
  magpie: 'missing',
  ollama: 'missing',
  brew: 'missing',
  npm: 'missing',
  host: 'direct'
}
const row = (rows: readonly PreflightRow[], id: PreflightRow['id']): PreflightRow => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

describe('the rows', () => {
  it('lists the tools in the order they matter, every harness the app can run', () => {
    expect(preflightRows(allFound).map((r) => r.id)).toEqual(['claude', 'codex', 'pi', 'opencode', 'multiplexer', 'chrome', 'magpie', 'ollama'])
  })

  it('marks only Magpie and Ollama optional', () => {
    const optional = preflightRows(allFound).filter((r) => r.optional).map((r) => r.id)
    expect(optional).toEqual(['magpie', 'ollama'])
  })

  it('offers nothing where everything is found', () => {
    expect(preflightRows(allFound).every((r) => r.state === 'found' && r.fix === null && r.note === null)).toBe(true)
  })

  it('counts either herdr or tmux as keeping agents alive', () => {
    expect(row(preflightRows({ ...allFound, herdr: 'missing' }), 'multiplexer').state).toBe('found')
    expect(row(preflightRows({ ...allFound, tmux: 'missing' }), 'multiplexer').state).toBe('found')
    expect(row(preflightRows({ ...allFound, herdr: 'missing', tmux: 'missing' }), 'multiplexer').state).toBe('missing')
  })

  it('says the plain consequence of having neither', () => {
    const line = row(preflightRows({ ...allFound, herdr: 'missing', tmux: 'missing', host: 'direct' }), 'multiplexer')
    expect(line.note).toBe('Without it, your agents stop when you close Cookrew.')
  })

  it('says a restart is due when one was installed after the app started', () => {
    const line = row(preflightRows({ ...allFound, herdr: 'missing', host: 'direct' }), 'multiplexer')
    expect(line.state).toBe('found')
    expect(line.note).toBe('Installed. Restart Cookrew to turn it on.')
  })

  it('stays quiet about a host it could not read', () => {
    expect(row(preflightRows({ ...allFound, host: null }), 'multiplexer').note).toBeNull()
  })
})

describe('the fix each row offers', () => {
  it('installs Claude Code with no other tool on the machine', () => {
    const fix = row(preflightRows(bareMac), 'claude').fix
    expect(fix?.line).toBe('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('prefers npm for Codex, then Homebrew, then its own release: no box is left without a press', () => {
    expect(row(preflightRows({ ...bareMac, npm: 'found' }), 'codex').fix?.line).toBe('npm i -g @openai/codex')
    expect(row(preflightRows({ ...bareMac, brew: 'found' }), 'codex').fix?.line).toBe('brew install codex')
    expect(row(preflightRows(bareMac), 'codex').fix?.line).toContain('codex-aarch64-apple-darwin.tar.gz')
    expect(row(preflightRows({ ...bareMac, platform: 'linux', arch: 'x64' }), 'codex').fix?.line).toContain('codex-x86_64-unknown-linux-musl.tar.gz')
  })

  it('installs Pi from its own release, with no npm or Node on the box', () => {
    const line = row(preflightRows({ ...bareMac, platform: 'linux', arch: 'x64' }), 'pi').fix?.line
    expect(line).toContain('releases/latest/download/pi-linux-x64.tar.gz')
    expect(line).not.toMatch(/\bnpm\b|\bnode\b/)
  })

  it('installs OpenCode with its own script', () => {
    expect(row(preflightRows(bareMac), 'opencode').fix?.line).toBe('curl -fsSL https://opencode.ai/install | bash')
  })

  it('offers no release it does not know the name of', () => {
    expect(row(preflightRows({ ...bareMac, arch: 'ia32' }), 'pi').fix).toBeNull()
  })

  it('installs tmux for the missing keeper, through Homebrew', () => {
    expect(row(preflightRows({ ...bareMac, brew: 'found' }), 'multiplexer').fix).toEqual({ label: 'Install tmux', line: 'brew install tmux' })
    expect(row(preflightRows(bareMac), 'multiplexer').fix?.label).toBe('Install Homebrew first')
  })

  it('gets Chrome and Ollama without Homebrew by opening their download pages', () => {
    expect(row(preflightRows({ ...bareMac, brew: 'found' }), 'chrome').fix?.line).toBe('brew install --cask google-chrome')
    expect(row(preflightRows(bareMac), 'chrome').fix?.line).toBe('open https://www.google.com/chrome/')
    expect(row(preflightRows({ ...bareMac, brew: 'found' }), 'ollama').fix?.line).toBe('brew install ollama')
    expect(row(preflightRows(bareMac), 'ollama').fix?.line).toBe('open https://ollama.com/download')
  })

  it('offers no Homebrew off a Mac', () => {
    const linux = preflightRows({ ...bareMac, platform: 'linux' })
    expect(row(linux, 'multiplexer').fix).toBeNull()
    expect(row(linux, 'chrome').fix).toBeNull()
    expect(row(linux, 'ollama').fix).toBeNull()
  })

  it('offers a sign-in for a tool that is found and not signed in, without calling it missing', () => {
    const rows = preflightRows({ ...allFound, claudeSignedIn: false, codexSignedIn: false })
    expect(row(rows, 'claude').state).toBe('found')
    expect(row(rows, 'claude').fix).toEqual({ label: 'Sign in', line: 'claude' })
    expect(row(rows, 'codex').fix).toEqual({ label: 'Sign in', line: 'codex login' })
  })

  it('takes an endpoint for a sign-in, on the tools that run on it', () => {
    const rows = preflightRows({ ...allFound, claudeSignedIn: false, codexSignedIn: false, endpointTools: ['Claude Code', 'Pi'] })
    expect(row(rows, 'claude').fix).toBeNull()
    expect(row(rows, 'codex').fix?.label).toBe('Sign in')
  })

  it('never offers an install for a state it could not read', () => {
    expect(preflightRows(UNKNOWN_FACTS).every((r) => r.state === 'unknown' && r.fix === null)).toBe(true)
  })

  it('types only lines the Setup card accepts, in every combination of facts', () => {
    const states: readonly ToolState[] = ['found', 'missing', 'unknown']
    for (const brew of states) {
      for (const npm of states) {
        for (const signedIn of [true, false, null]) {
          const facts = { ...bareMac, brew, npm, claudeSignedIn: signedIn, codexSignedIn: signedIn, platform: brew === 'found' ? 'darwin' : 'linux', arch: npm === 'found' ? 'x64' : 'arm64' }
          for (const r of [...preflightRows(facts), ...preflightRows({ ...facts, claude: 'found', codex: 'found' })]) {
            if (r.fix) expect(setupLineAllowed(r.fix.line), r.fix.line).toBe(true)
          }
        }
      }
    }
  })

  it('names the same lines main already types: one install line per tool', () => {
    const facts = (id: string) => HARNESS_FACTS.find((h) => h.id === id)
    expect(row(preflightRows({ ...bareMac, npm: 'found' }), 'codex').fix?.line).toBe(facts('codex')?.installLine)
    expect(row(preflightRows({ ...allFound, codexSignedIn: false }), 'codex').fix?.line).toBe(facts('codex')?.loginLine)
    expect(row(preflightRows({ ...allFound, claudeSignedIn: false }), 'claude').fix?.line).toBe(facts('claude')?.loginLine)
    expect(row(preflightRows(bareMac), 'magpie').fix?.line).toBe(INSTALL_LINE)
  })
})

describe('whether the person may go on', () => {
  it('needs one tool that runs agents, whichever it is', () => {
    expect(mayContinue(preflightRows(bareMac))).toBe(false)
    for (const id of ['claude', 'codex', 'pi', 'opencode']) expect(mayContinue(preflightRows({ ...bareMac, [id]: 'found' })), id).toBe(true)
  })

  it('never blocks on anything else', () => {
    expect(mayContinue(preflightRows({ ...bareMac, claude: 'found', herdr: 'missing', tmux: 'missing', chrome: 'missing' }))).toBe(true)
  })

  it('never blocks on a check that failed', () => {
    expect(mayContinue(preflightRows(UNKNOWN_FACTS))).toBe(true)
    expect(mayContinue(preflightRows({ ...bareMac, claude: 'unknown' }))).toBe(true)
  })
})

describe('a fix that needs admin rights says so before it is pressed (N2)', () => {
  const green = allFound
  const missing = { ...green, magpie: 'missing' as const }
  const note = (facts: ToolFacts, id: string): string | null | undefined => preflightRows(facts).find((r) => r.id === id)?.note

  it('Magpie on Linux, whose installer can reach for sudo', () => {
    expect(note({ ...missing, platform: 'linux' }, 'magpie')).toBe(TOOL_NOTES.ADMIN)
  })

  it('not Magpie on a Mac, whose installer never does', () => {
    expect(note({ ...missing, platform: 'darwin' }, 'magpie')).toBeNull()
  })

  it('Homebrew, beside what its absence costs', () => {
    const facts = { ...green, herdr: 'missing' as const, tmux: 'missing' as const, brew: 'missing' as const, platform: 'darwin' }
    expect(note(facts, 'multiplexer')).toBe(`${TOOL_NOTES.NOT_KEPT} ${TOOL_NOTES.ADMIN}`)
  })

  it('nothing on a tool that is found', () => {
    expect(note({ ...green, platform: 'linux' }, 'magpie')).toBeNull()
  })
})

describe('xdotool, the Linux hand for remote control', () => {
  const linux: ToolFacts = { ...allFound, platform: 'linux', arch: 'x64', brew: 'missing' }

  it('is a row on Linux only, optional, and never what holds anyone back', () => {
    expect(preflightRows({ ...linux, xdotool: 'found' }).find((r) => r.id === 'xdotool')).toMatchObject({ state: 'found', optional: true, fix: null })
    expect(preflightRows({ ...allFound, xdotool: 'missing' }).some((r) => r.id === 'xdotool')).toBe(false)
    expect(mayContinue(preflightRows({ ...linux, xdotool: 'missing' }))).toBe(true)
  })

  it('missing, it holds the one line that installs it, which the Setup card accepts, and says it may ask for the password', () => {
    const r = preflightRows({ ...linux, xdotool: 'missing' }).find((candidate) => candidate.id === 'xdotool')
    expect(r?.fix?.line).toBe(XDOTOOL_INSTALL)
    expect(setupLineAllowed(XDOTOOL_INSTALL)).toBe(true)
    expect(r?.note).toBe(TOOL_NOTES.ADMIN)
    expect(r?.does).toMatch(/click and type/)
  })

  it('a check that failed is unknown, with no install', () => {
    expect(preflightRows(linux).find((r) => r.id === 'xdotool')).toMatchObject({ state: 'unknown', fix: null })
  })
})
