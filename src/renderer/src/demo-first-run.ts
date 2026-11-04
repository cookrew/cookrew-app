import type { CookrewApi } from './api'
import type { AccountStatus } from '../../shared/account-v2'
import type { AgentRegistryEntry } from './agent-registry'
import { advancedStage, isFirstRunStage, type FirstRunStage } from '../../shared/first-run'
import { preflightRows, UNKNOWN_FACTS, type ToolFacts } from '../../shared/preflight'
import type { TerminalActivity } from '../../shared/turn'

/**
 * A FRESH INSTALL, IN THE BROWSER DEMO. `?fresh=gaps|green|none|unknown` makes
 * the demo a Mac with nothing on it and that set of tools; `&stage=task` opens
 * further along. It answers the same bridge main does, so QA walks the real
 * screens with no Mac behind them, and an agent plays a short turn so the
 * phone offer and the second-agent hint can be seen. It is a Mac with no
 * account, so the avatar and the account card behave as they will for a new
 * person. Nothing is kept: a reload starts over. Without the parameter the
 * demo is exactly what it was.
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
  herdr: 'found',
  tmux: 'found',
  chrome: 'found',
  magpie: 'found',
  ollama: 'found',
  brew: 'found',
  npm: 'found',
  host: 'herdr',
  platform: 'darwin'
}

/** A new Mac with Homebrew and Claude Code on it, and nothing else. */
const GAPS: ToolFacts = {
  ...GREEN,
  codex: 'missing',
  codexSignedIn: null,
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

const STAND_IN_REPLY = 'Done. (A stand-in reply: the demo runs no real agent.)'

function turnActivity(terminalId: string, phase: TerminalActivity['phase'], prompt: string, turnCount: number): TerminalActivity {
  const replied = phase === 'replied'
  return {
    terminalId,
    agent: true,
    phase,
    prompt,
    pendingInput: null,
    lines: replied ? [STAND_IN_REPLY] : [],
    reply: replied ? STAND_IN_REPLY : null,
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
  const asked = new URLSearchParams(search).get('stage')
  let stage: FirstRunStage = isFirstRunStage(asked) ? asked : 'preflight'
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
      emit(turnActivity(id, 'replied', prompt, before + 1))
    }, TURN_ENDS_MS)
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
    firstRunPreflight: () => Promise.resolve(preflightRows(freshFacts(mode))),
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
      const prompt = (opts as { prompt?: string }).prompt
      if (prompt) {
        const entry = { id: node.id, name: node.name, preset: (opts as { preset: string }).preset, role: null, cwd: '~', workspaceId: 'demo-ws', workspaceName: 'My Workspace', spawnedAt: Date.now(), orch: false, active: true }
        roster = [...roster, entry]
        for (const listener of rosterListeners) listener([...roster])
        turns.set(node.id, 0)
        playTurn(node.id, prompt)
      }
      return node
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
