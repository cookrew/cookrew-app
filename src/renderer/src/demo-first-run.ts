import type { CookrewApi } from './api'
import type { AccountStatus } from '../../shared/account-v2'
import type { AgentRegistryEntry } from './agent-registry'
import { advancedStage, isFirstRunStage, waitOfScreen, type FirstRunStage, type FirstTask } from '../../shared/first-run'
import { ACCESS_ROWS, accessTools, checkEndpoint, type AccessState, type EndpointInput } from '../../shared/agent-access'
import { preflightRows, UNKNOWN_FACTS, type ToolFacts } from '../../shared/preflight'
import type { TerminalActivity } from '../../shared/turn'

/**
 * A FRESH INSTALL, IN THE BROWSER DEMO. `?fresh=gaps|green|none|unknown` makes
 * the demo a Mac with nothing on it and that set of tools; `&stage=task` opens
 * further along. It answers the same bridge main does, so QA walks the real
 * screens with no Mac behind them, and an agent plays a short turn so the
 * phone offer and the second-agent hint can be seen. `&agent=asks|signin|consent`
 * holds the first task on that screen and `&agent=dies` hands it back, as main
 * does. It is a Mac with no account, so the avatar and the account card behave as
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
  consent: 'WARNING: Claude Code running in Bypass Permissions mode\r\n\r\nBy proceeding, you accept all responsibility for actions taken.\r\n\r\n❯ No, exit\r\n  Yes, I accept\r\n\r\nEnter to confirm · Esc to cancel\r\n'
}
const HOLD_MS = 500

const STAND_IN_REPLY = 'Done. (A stand-in reply: the demo runs no real agent.)'
const REFUSED_REPLY = 'API Error: 400 Unable to generate parser for this template'

function turnActivity(terminalId: string, phase: TerminalActivity['phase'], prompt: string, turnCount: number, reply = STAND_IN_REPLY): TerminalActivity {
  const replied = phase === 'replied'
  return {
    terminalId,
    agent: true,
    phase,
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
  let stage: FirstRunStage = isFirstRunStage(asked) ? asked : 'preflight'
  let task: FirstTask | null = null
  let access: AccessState = { rows: ACCESS_ROWS, active: null }
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
  /** As main/first-task.ts does it, played for the demo's agent. */
  const holdTask = (id: string, words: string, harness: string): void => {
    task = { state: 'holding', id, words, harness, wait: 'starting' }
    tell()
    setTimeout(() => {
      if (agent === 'dies') {
        task = { state: 'returned', words, why: `${harness} stopped before it took your task. Your words are back in the box.`, id }
        void api.removeNode(id)
      } else if (SCREENS[agent]) {
        task = { state: 'holding', id, words, harness, wait: waitOfScreen(SCREENS[agent]) }
      } else {
        task = null
        stage = advancedStage(stage, 'phone')
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
      return Promise.resolve(stage)
    },
    firstRunPreflight: () => Promise.resolve(preflightRows({ ...freshFacts(mode), endpointTools: access.active?.tools ?? [] })),
    firstRunTask: () => Promise.resolve(task),
    firstRunDiscard: () => {
      if (task?.state === 'holding') {
        const { id, words } = task
        task = { state: 'returned', words, why: null, id }
        void api.removeNode(id)
        tell()
      }
      return Promise.resolve()
    },
    firstRunCanStart: (preset) => {
      const facts = freshFacts(mode)
      const state = preset === 'Codex' ? facts.codex : preset === 'Pi' ? facts.pi : preset === 'OpenCode' ? facts.opencode : facts.claude
      return Promise.resolve(state === 'missing' ? `${preset} is not installed yet. Check this computer again to install it.` : null)
    },
    onFirstRun: (listener) => {
      viewListeners.add(listener)
      return () => viewListeners.delete(listener)
    },
    accessState: () => Promise.resolve(access),
    accessSave: (input: EndpointInput) => {
      const checked = checkEndpoint(input)
      if (!checked.ok) return Promise.resolve(checked)
      const { protocol, baseUrl, model } = checked.value
      access = { rows: ACCESS_ROWS, active: { id: 'endpoint', label: 'Your endpoint', protocol, model, host: new URL(baseUrl).host, tools: accessTools({ protocol }) } }
      return Promise.resolve({ ok: true as const, state: access })
    },
    accessClear: () => {
      access = { rows: ACCESS_ROWS, active: null }
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
      if (task0?.state === 'holding' && task0.id === id && SCREENS[agent]) setTimeout(() => onData(`\x1b[2J\x1b[H${SCREENS[agent]}`), 200)
      return off
    },
    ptyInput: (id, data) => {
      api.ptyInput(id, data)
      if (!turns.has(id)) return
      const words = `${typed.get(id) ?? ''}${data}`.replace(/\x7f/g, '')
      typed.set(id, data.includes('\r') ? '' : words)
      if (data.includes('\r')) playTurn(id, words.replace(/\r/g, '').trim())
    }
  }
}
