import type { CookrewApi } from './api'
import type { AccountStatus } from '../../shared/account-v2'
import type { AgentRegistryEntry } from './agent-registry'
import { advancedStage, isFirstRunStage, pastTask, waitOfScreen, type FirstRunStage, type FirstTask } from '../../shared/first-run'
import { ACCESS_ROWS, accessTools, checkEndpoint, simpleModeHelps, type AccessState, type EndpointInput } from '../../shared/agent-access'
import { SETUP_LINE_COPY } from '../../shared/first-run-copy'
import { preflightRows, UNKNOWN_FACTS, type ToolFacts } from '../../shared/preflight'
import type { SetupLineAsk, SetupLineNow, SetupStart } from '../../shared/setup-line'
import type { TerminalActivity } from '../../shared/turn'

/**
 * A FRESH INSTALL, IN THE BROWSER DEMO. `?fresh=gaps|green|none|unknown` makes
 * the demo a Mac with nothing on it and that set of tools; `&stage=task` opens
 * further along. It answers the same bridge main does, so QA walks the real
 * screens with no Mac behind them, and an agent plays a short turn so the
 * phone offer and the second-agent hint can be seen. `&agent=asks|signin|consent`
 * holds the first task on that screen and `&agent=dies` hands it back, as main
 * does. `&setup=fail|sudo` plays a Setup line that fails, or stops on a password
 * prompt until Stop. It is a Mac with no account, so the avatar and the account card behave as
 * they will for a new person. Nothing is kept: a reload starts over. Without the
 * parameter the demo is exactly what it was.
 */

export type FreshMode = 'gaps' | 'green' | 'none' | 'unknown'

const MODES: readonly FreshMode[] = ['gaps', 'green', 'none', 'unknown']
const TURN_STARTS_MS = 300
const TURN_ENDS_MS = 1_800

export function freshMode(search: string): FreshMode | null {
  const word = new URLSearchParams(search).get('fresh')
  return MODES.find((mode) => mode === word) ?? null
}

const GREEN: ToolFacts = {
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

/** A new Mac with Homebrew and Claude Code on it, and nothing else. */
const GAPS: ToolFacts = {
  ...GREEN,
  codex: 'missing',
  codexSignedIn: null,
  pi: 'missing',
  opencode: 'missing',
  herdr: 'missing',
  tmux: 'missing',
  chrome: 'missing',
  magpie: 'missing',
  ollama: 'missing',
  npm: 'missing',
  host: 'direct'
}

export function freshFacts(mode: FreshMode): ToolFacts {
  if (mode === 'green') return GREEN
  if (mode === 'gaps') return GAPS
  return mode === 'none' ? { ...GAPS, claude: 'missing', claudeSignedIn: null, brew: 'missing' } : UNKNOWN_FACTS
}

/** What a brand-new agent shows, for `&agent=`: seen on Claude Code 2.1.316, shortened. */
const SCREENS: Readonly<Record<string, string>> = {
  asks: "Let's get started.\r\n\r\nChoose the text style that looks best with your terminal\r\n\r\n  Auto (match terminal)\r\n❯ ✔ Dark mode\r\n  Light mode\r\n",
  signin: 'Select login method:\r\n\r\n❯ Claude account with subscription\r\n  Anthropic Console account\r\n',
  consent: 'WARNING: Claude Code running in Bypass Permissions mode\r\n\r\nIn Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.\r\nThis mode should only be used in a sandboxed container or VM that has restricted internet access and can easily be restored if damaged.\r\n\r\nBy proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.\r\n\r\n❯ No, exit\r\n  Yes, I accept\r\n\r\nEnter to confirm · Esc to cancel\r\n'
}
const HOLD_MS = 500
const SETUP_LINE_MS = 1_200
const RESTART_MS = 400
const SUDO_PROMPT = '[sudo] password for you:'

/** The word a preset runs, as a card's failure names it. */
const commandOf = (preset: string): string => preset.split(' ')[0].toLowerCase()

const STAND_IN_REPLY = 'Done. (A stand-in reply: the demo runs no real agent.)'
const REFUSED_REPLY = 'API Error: 400 Unable to generate parser for this template'

function turnActivity(terminalId: string, phase: TerminalActivity['phase'], prompt: string, turnCount: number, reply = STAND_IN_REPLY): TerminalActivity {
  const replied = phase === 'replied'
  return {
    terminalId,
    agent: true,
    phase,
    asked: true,
    prompt,
    pendingInput: null,
    lines: replied ? [reply] : [],
    reply: replied ? reply : null,
    glance: null,
    title: null,
    turnCount,
    turnStartLine: null,
    scrollRow: null,
    tailLines: null,
    scrollBase: null,
    turnStartedAt: null,
    dispatchId: null,
    updatedAt: Date.now()
  }
}

const NO_ACCOUNT = {
  username: null,
  displayName: '',
  avatar: null,
  locked: false,
  lockAfterMs: 0,
  requests: 0,
  envUsername: null,
  legacy: null,
  recoveryCodesSavedAt: null,
  recoveryCodesLeft: null,
  sessionExpired: false,
  passwordPending: false
} as unknown as AccountStatus

export function freshDemoApi(api: CookrewApi, mode: FreshMode, search: string): CookrewApi {
  const query = new URLSearchParams(search)
  const asked = query.get('stage')
  const agent = query.get('agent') ?? 'ok'
  const setupPlay = query.get('setup') ?? 'ok'
  /** The tools a demo line has installed, and the line running now. */
  let installed: readonly string[] = []
  let setupRun: { readonly runId: string; readonly line: string; readonly at: number; stopped: boolean } | null = null
  const factsNow = (): ToolFacts => {
    const facts = freshFacts(mode)
    return installed.reduce<ToolFacts>((next, tool) => ({ ...next, [tool]: 'found' }), facts)
  }
  let stage: FirstRunStage = isFirstRunStage(asked) ? asked : 'preflight'
  let task: FirstTask | null = null
  const keyStore = query.get('key') === 'file' ? ('file' as const) : ('keychain' as const)
  // A refused turn is what a third-party endpoint in full mode gets, so that is what it plays on.
  const baseUrl = 'https://api.example.com'
  const refusedOn = { id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic' as const, model: 'm-1', host: 'api.example.com', baseUrl, simple: false, tools: accessTools({ protocol: 'anthropic', baseUrl }) }
  let access: AccessState = { rows: ACCESS_ROWS, keyStore, active: agent === 'refused' ? refusedOn : null }
  const viewListeners = new Set<(view: { stage: FirstRunStage; task: FirstTask | null }) => void>()
  const tell = (): void => {
    for (const listener of viewListeners) listener({ stage, task })
  }
  const listeners = new Set<(activity: TerminalActivity) => void>()
  /** Agents made with a prompt, and the turns each has finished. */
  const turns = new Map<string, number>()
  /** What was typed since the last Enter, per agent: the next turn's prompt. */
  const typed = new Map<string, string>()
  /** The crew reads its rows from here, so a card shows its turn. */
  let roster: readonly AgentRegistryEntry[] = []
  const rosterListeners = new Set<(list: AgentRegistryEntry[]) => void>()
  const emit = (activity: TerminalActivity): void => {
    for (const listener of listeners) listener(activity)
  }
  const playTurn = (id: string, prompt: string): void => {
    const before = turns.get(id) ?? 0
    setTimeout(() => emit(turnActivity(id, 'thinking', prompt, before)), TURN_STARTS_MS)
    setTimeout(() => {
      turns.set(id, before + 1)
      emit(turnActivity(id, 'replied', prompt, before + 1, agent === 'refused' ? REFUSED_REPLY : STAND_IN_REPLY))
    }, TURN_ENDS_MS)
  }
  /**
   * A restart as the card really sees one (box round 3, N10): the old pane's last
   * word, a new mirror with nothing on it yet, a spinner nobody asked for, then the same
   * refusal read back with other words around it. The card must keep its place throughout.
   */
  const restartRefused = (id: string): Promise<void> => {
    const prompt = 'Write a short README for this folder'
    const count = turns.get(id) ?? 1
    emit({ ...turnActivity(id, 'idle', prompt, count), lines: ['— process exited —'], reply: REFUSED_REPLY })
    setTimeout(() => emit({ ...turnActivity(id, 'idle', prompt, count), prompt: null, lines: [] }), RESTART_MS / 2)
    setTimeout(() => emit({ ...turnActivity(id, 'thinking', prompt, count), asked: false }), RESTART_MS * 1.5)
    setTimeout(() => emit({ ...turnActivity(id, 'idle', prompt, count), lines: [`⎿  ${REFUSED_REPLY}`], reply: `${REFUSED_REPLY}\nRead back from the transcript.` }), RESTART_MS * 2)
    return new Promise((resolve) => setTimeout(resolve, RESTART_MS))
  }
  /** As main/first-task.ts does it, played for the demo's agent. */
  const holdTask = (id: string, words: string, harness: string): void => {
    task = { state: 'holding', id, words, harness, wait: 'starting' }
    tell()
    setTimeout(() => {
      if (agent === 'dies') {
        task = { state: 'returned', words, why: `${commandOf(harness)} stopped right after it started (exit 1).`, fix: 'Its last lines are below. Send again to start it again.', lines: ['Error: could not reach the model'], id }
        void api.removeNode(id)
      } else if (SCREENS[agent]) {
        task = { state: 'holding', id, words, harness, wait: waitOfScreen(SCREENS[agent]) }
      } else {
        task = { state: 'sent', id, words, harness }
        playTurn(id, words)
      }
      tell()
    }, HOLD_MS)
  }
  const extra = {
    addWorkspaceDir: () => api.listWorkspaces(),
    setPrimaryDir: () => api.listWorkspaces(),
    listAgents: () => Promise.resolve([...roster]),
    onAgentRegistry: (listener: (list: AgentRegistryEntry[]) => void) => {
      rosterListeners.add(listener)
      return () => rosterListeners.delete(listener)
    }
  }
  return {
    ...api,
    ...extra,
    firstRunRead: () => Promise.resolve(stage),
    firstRunAdvance: (to) => {
      stage = advancedStage(stage, to)
      if (task?.state === 'sent' && pastTask(stage)) task = null
      return Promise.resolve(stage)
    },
    firstRunPreflight: () => Promise.resolve(preflightRows({ ...factsNow(), endpointTools: access.active?.tools ?? [] })),
    setupLineStart: ({ terminalId, line, enter }: SetupLineAsk): Promise<SetupStart> => {
      if (setupRun !== null) return Promise.resolve({ ok: false, reason: SETUP_LINE_COPY.BUSY, busy: true })
      api.ptyInput(terminalId, enter ? `${line}\r` : line)
      if (!enter) return Promise.resolve({ ok: true, runId: null })
      setupRun = { runId: `demo-${Date.now()}`, line, at: Date.now(), stopped: false }
      return Promise.resolve({ ok: true, runId: setupRun.runId })
    },
    setupLineNow: (_terminalId: string, runId: string): Promise<SetupLineNow> => {
      const run = setupRun
      if (run?.runId !== runId) return Promise.resolve({ state: 'none' })
      const end = (code: number): Promise<SetupLineNow> => {
        setupRun = null
        return Promise.resolve({ state: 'ended', code })
      }
      if (run.stopped) return end(130)
      if (setupPlay === 'sudo') return Promise.resolve({ state: 'running', lastLine: SUDO_PROMPT, asking: 'password' })
      if (Date.now() - run.at < SETUP_LINE_MS) return Promise.resolve({ state: 'running', lastLine: 'Downloading…', asking: null })
      if (setupPlay === 'fail') return end(1)
      const tool = (run.line.match(/\b(tmux|pi|codex|magpie|ollama|chrome|opencode)\b/) ?? [])[1]
      if (tool) installed = [...installed, tool]
      return end(0)
    },
    firstRunTask: () => Promise.resolve(task),
    firstRunDiscard: () => {
      if (task?.state === 'holding' || task?.state === 'sent') {
        const { id, words, state } = task
        task = { state: 'returned', words, why: null, id }
        if (state === 'holding') void api.removeNode(id)
        tell()
      }
      return Promise.resolve()
    },
    firstRunCanStart: (preset) => {
      const facts = freshFacts(mode)
      const state = preset === 'Codex' ? facts.codex : preset === 'Pi' ? facts.pi : preset === 'OpenCode' ? facts.opencode : facts.claude
      return Promise.resolve(state === 'missing' ? `Command not found: ${commandOf(preset)}. Install ${commandOf(preset)} or add it to PATH, then send again.` : null)
    },
    onFirstRun: (listener) => {
      viewListeners.add(listener)
      return () => viewListeners.delete(listener)
    },
    accessState: () => Promise.resolve(access),
    accessSave: (input: EndpointInput) => {
      // As main does on an edit: an empty key is the saved one.
      const checked = checkEndpoint(access.active && input.key === '' ? { ...input, key: 'demo-saved-key' } : input)
      if (!checked.ok) return Promise.resolve(checked)
      const { protocol, baseUrl, model, simple } = checked.value
      access = { rows: ACCESS_ROWS, keyStore, active: { id: 'endpoint', label: 'Your endpoint', protocol, model, host: new URL(baseUrl).host, baseUrl, simple: simple === true, tools: accessTools({ protocol, baseUrl, simple }) } }
      return Promise.resolve({ ok: true as const, state: access })
    },
    accessSimple: ({ terminalId }) => {
      if (access.active === null) return Promise.resolve({ ok: false as const })
      access = { ...access, active: { ...access.active, simple: true, tools: accessTools({ ...access.active, simple: true }) } }
      const state = access
      return restartRefused(terminalId).then(() => ({ ok: true as const, restarted: true, state }))
    },
    accessSimpleOffer: () => Promise.resolve(simpleModeHelps('Claude Code', access.active)),
    accessClear: () => {
      access = { rows: ACCESS_ROWS, keyStore, active: null }
      return Promise.resolve(access)
    },
    pickDir: () => Promise.resolve('/Users/you/Projects/my-site'),
    accountPairingUrl: () => Promise.resolve({ url: 'https://192.168.1.20:8643/?token=demo-token', via: 'direct' as const, desktopName: 'This Mac' }),
    accountStatus: () => Promise.resolve(NO_ACCOUNT),
    accountClaim: () => Promise.reject(new Error('the demo has no account to claim')),
    onTerminalActivity: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    createTerminal: async (opts) => {
      const node = await api.createTerminal(opts)
      const { prompt, patient, preset } = opts as { prompt?: string; patient?: boolean; preset: string }
      if (prompt) {
        const entry = { id: node.id, name: node.name, preset, role: null, cwd: '~', workspaceId: 'demo-ws', workspaceName: 'My Workspace', spawnedAt: Date.now(), orch: false, active: true }
        roster = [...roster, entry]
        for (const listener of rosterListeners) listener([...roster])
        turns.set(node.id, 0)
        if (patient) holdTask(node.id, prompt, preset)
        else playTurn(node.id, prompt)
      }
      return node
    },
    ptyAttach: (id, onData, onSize) => {
      const task0 = task
      const off = api.ptyAttach(id, onData, onSize)
      // A young pane on a card's tall grid: the prompt is near the top of it.
      if (setupPlay === 'sudo' && !turns.has(id)) {
        setTimeout(() => onSize?.({ cols: 100, rows: 44 }), 150)
        setTimeout(() => onData(`\r\n${SUDO_PROMPT} `), 300)
      }
      if (task0?.state === 'holding' && task0.id === id && SCREENS[agent]) {
        // As wide and tall as a card's pane, which is what clipped them (box round 3, N7).
        setTimeout(() => onSize?.({ cols: 130, rows: 44 }), 150)
        setTimeout(() => onData(`\x1b[2J\x1b[H${SCREENS[agent]}`), 200)
      }
      return off
    },
    ptyInput: (id, data) => {
      api.ptyInput(id, data)
      if (data === '\x03' && setupRun !== null) setupRun.stopped = true
      if (!turns.has(id)) return
      const words = `${typed.get(id) ?? ''}${data}`.replace(/\x7f/g, '')
      typed.set(id, data.includes('\r') ? '' : words)
      if (data.includes('\r')) playTurn(id, words.replace(/\r/g, '').trim())
    }
  }
}
