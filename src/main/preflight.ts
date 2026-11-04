import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { UNKNOWN_FACTS, type ToolFacts, type ToolState } from '../shared/preflight'
import { HarnessScan, onPath } from './route/setup'

/**
 * WHAT THIS MACHINE HAS (first run, the tool check).
 *
 * Every check stands alone and a check that throws reads "unknown", so one bad
 * answer costs one row and never the screen. A tool is found by its FILE: no
 * tool is started here. Running `herdr` from a pane can stop the app's own
 * server, and a check has no business waking anything.
 *
 * PATH IS WHERE THE AGENTS WILL RUN: the app's own, plus what the person's
 * login shell adds (nvm and friends only exist there), read once per check and
 * bounded, since an rc file may do anything. Panes start on the app's PATH, so
 * what the shell added is handed to the app (`adoptDirs`): Found has to mean
 * the agent can start, not that a shell somewhere could find it.
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
  pathEnv: string | undefined
  platform: string
  exists: (file: string) => boolean
  /** Claude Code and Codex, as the route panel reads them. */
  agents: (pathEnv: string) => Promise<readonly AgentFact[]>
  chrome: () => boolean
  magpie: () => boolean
  /** The backend hosting terminals now. */
  host: () => string | null
  shellDirs: () => Promise<readonly string[]>
  /** Give the app the dirs the login shell had, for the panes it starts next. */
  adoptDirs?: (dirs: readonly string[]) => void
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

async function factsNow(deps: ProbeDeps): Promise<ToolFacts> {
  const shell = await deps.shellDirs().catch(() => [] as readonly string[])
  deps.adoptDirs?.(shell)
  const pathEnv = [deps.pathEnv ?? '', ...shell].filter((dir) => dir !== '').join(path.delimiter)
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
    claudeSignedIn: claude.signedIn,
    codex: codex.state,
    codexSignedIn: codex.signedIn,
    herdr: bin('herdr'),
    tmux: bin('tmux'),
    chrome: check(deps.chrome),
    magpie: check(deps.magpie),
    ollama,
    brew: bin('brew'),
    npm: bin('npm'),
    host,
    platform: deps.platform
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
export function machineProbe(deps: Pick<ProbeDeps, 'chrome' | 'magpie' | 'host' | 'adoptDirs'>): ProbeDeps {
  const home = homedir()
  return {
    home,
    pathEnv: process.env.PATH,
    platform: process.platform,
    exists: existsSync,
    agents: (pathEnv) => {
      const scan = new HarnessScan({ home, pathEnv, dockCommands: () => [], harnessOfCommand: () => null, installed: (bin) => onPath(bin, pathEnv) })
      return scan.rowsSettled().finally(() => scan.dispose())
    },
    shellDirs: () => readLoginShellDirs(),
    ...deps
  }
}
