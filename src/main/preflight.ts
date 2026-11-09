import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { UNKNOWN_FACTS, type ToolFacts, type ToolState } from '../shared/preflight'
import { HarnessScan, onPath } from './route/setup'
import { bypassConsentState } from './claude-consent'

/**
 * WHAT THIS MACHINE HAS (first run, the tool check).
 *
 * Every check stands alone and a check that throws reads "unknown", so one bad
 * answer costs one row and never the screen. A tool is found by its FILE: no
 * tool is started here. Running `herdr` from a pane can stop the app's own
 * server, and a check has no business waking anything.
 *
 * THE PATH IS THE ONE PANES GET (pane-path.ts), in every build. What the login
 * shell knows (nvm and friends live only there) is read once per check, bounded
 * since an rc file may do anything, and handed over FIRST: the check then looks
 * only where a pane would. Found means the agent can start, not that some shell
 * somewhere could find it.
 */

const PROBE_BUDGET_MS = 8_000
const SHELL_BUDGET_MS = 3_000
const PATH_MARK = '__COOKREW_PATH__'

export interface AgentFact {
  id: string
  installed: boolean
  signedIn: boolean | null
}

export interface ProbeDeps {
  home: string
  /** What a pane gets, read after `adoptDirs`. */
  panePath: () => string
  /** Give panes the dirs the login shell had. */
  adoptDirs: (dirs: readonly string[]) => void
  platform: string
  exists: (file: string) => boolean
  /** Claude Code and Codex, as the route panel reads them. */
  agents: (pathEnv: string) => Promise<readonly AgentFact[]>
  chrome: () => boolean
  magpie: () => boolean
  /** The backend hosting terminals now. */
  host: () => string | null
  shellDirs: () => Promise<readonly string[]>
  /** The tools the person's own endpoint runs on, if they saved one. */
  endpointTools?: () => readonly string[]
  /** The processor: names the release to fetch. */
  arch?: string
  /** What panes inherit: a key here is a sign-in. */
  env?: Readonly<Record<string, string | undefined>>
  /** Claude's bypass-permissions notice, as the user settings hold it (claude-consent.ts). */
  claudeConsent?: () => 'accepted' | 'not-yet' | 'unreadable'
}

/** The directories on the marked line of the login shell's output. */
export function loginShellDirs(output: string): string[] {
  const line = output.split('\n').find((l) => l.startsWith(PATH_MARK))
  return line ? line.slice(PATH_MARK.length).split(path.delimiter).filter((dir) => dir !== '') : []
}

export function readLoginShellDirs(timeoutMs = SHELL_BUDGET_MS): Promise<string[]> {
  return new Promise((resolve) => {
    const shell = userInfo().shell ?? process.env.SHELL
    if (!shell) return resolve([])
    execFile(shell, ['-ilc', `printf '\\n${PATH_MARK}%s\\n' "$PATH"`], { timeout: timeoutMs }, (_error, stdout) => resolve(loginShellDirs(String(stdout ?? ''))))
  })
}

function check(found: () => boolean): ToolState {
  try {
    return found() ? 'found' : 'missing'
  } catch {
    return 'unknown'
  }
}

/** What the agent scan says of one tool; a failed scan says unknown of both. */
function agentState(agents: readonly AgentFact[] | null, id: string): { state: ToolState; signedIn: boolean | null } {
  if (agents === null) return { state: 'unknown', signedIn: null }
  const agent = agents.find((a) => a.id === id)
  return agent?.installed ? { state: 'found', signedIn: agent.signedIn } : { state: 'missing', signedIn: null }
}

/** A key a pane will inherit signs the agent in, whatever the login files say. */
function signedIn(fact: boolean | null, env: ProbeDeps['env'], keys: readonly string[]): boolean | null {
  return fact === false && keys.some((key) => Boolean(env?.[key])) ? true : fact
}

async function factsNow(deps: ProbeDeps): Promise<ToolFacts> {
  deps.adoptDirs(await deps.shellDirs().catch(() => [] as readonly string[]))
  const pathEnv = deps.panePath()
  const agents = await deps.agents(pathEnv).catch(() => null)
  const claude = agentState(agents, 'claude')
  const codex = agentState(agents, 'codex')
  const bin = (name: string): ToolState => {
    const onThisPath = (): boolean => pathEnv.split(path.delimiter).some((dir) => deps.exists(path.join(dir, name)))
    return check(onThisPath)
  }
  const ollama = check(() => bin('ollama') === 'found' || deps.exists('/Applications/Ollama.app'))
  let host: string | null = null
  try {
    host = deps.host()
  } catch {
    host = null
  }
  return {
    claude: claude.state,
    claudeSignedIn: signedIn(claude.signedIn, deps.env, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']),
    codex: codex.state,
    codexSignedIn: signedIn(codex.signedIn, deps.env, ['OPENAI_API_KEY', 'CODEX_API_KEY']),
    pi: agentState(agents, 'pi').state,
    opencode: agentState(agents, 'opencode').state,
    herdr: bin('herdr'),
    tmux: bin('tmux'),
    chrome: check(deps.chrome),
    magpie: check(deps.magpie),
    ollama,
    brew: bin('brew'),
    npm: bin('npm'),
    host,
    platform: deps.platform,
    arch: deps.arch ?? 'unknown',
    endpointTools: deps.endpointTools?.() ?? [],
    claudeConsent: claude.state === 'found' ? consentNow(deps) : null
  }
}

function consentNow(deps: ProbeDeps): 'accepted' | 'not-yet' | 'unreadable' | null {
  try {
    return deps.claudeConsent?.() ?? null
  } catch {
    return null
  }
}

/** Never rejects: past its budget the whole answer is unknown, which blocks nobody. */
export function probeTools(deps: ProbeDeps, budgetMs = PROBE_BUDGET_MS): Promise<ToolFacts> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(UNKNOWN_FACTS), budgetMs)
    void factsNow(deps)
      .then(resolve, () => resolve(UNKNOWN_FACTS))
      .finally(() => clearTimeout(timer))
  })
}

/** The real machine's checks; `chrome`, `magpie` and `host` come from what owns them. */
export function machineProbe(deps: Pick<ProbeDeps, 'chrome' | 'magpie' | 'host' | 'adoptDirs' | 'panePath' | 'endpointTools'>): ProbeDeps {
  const home = homedir()
  return {
    home,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    exists: existsSync,
    claudeConsent: () => bypassConsentState(path.join(home, '.claude', 'settings.json')),
    agents: (pathEnv) => {
      const scan = new HarnessScan({ home, pathEnv, dockCommands: () => [], harnessOfCommand: () => null, installed: (bin) => onPath(bin, pathEnv) })
      return scan.rowsSettled().finally(() => scan.dispose())
    },
    shellDirs: () => readLoginShellDirs(),
    ...deps
  }
}
