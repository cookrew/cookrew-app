import { FIX_LABELS, TOOL_COPY, TOOL_NOTES } from './first-run-copy'

/**
 * WHAT THIS MACHINE HAS, AS ROWS. Main answers the facts (main/preflight.ts);
 * this turns them into one calm row per tool. Every fix is a line the Setup
 * card accepts (shared/route-lines.ts), and it is chosen from what the machine
 * really has: a fresh Mac has neither npm nor Homebrew, so a line that needs
 * one of them would fail at the first press.
 *
 * "unknown" is a check that failed. It offers no install, since the tool may
 * well be there, and it stands in nobody's way.
 */

export type ToolState = 'found' | 'missing' | 'unknown'

export interface ToolFacts {
  claude: ToolState
  /** Null when the state above is not `found`, or nothing can be read. */
  claudeSignedIn: boolean | null
  codex: ToolState
  codexSignedIn: boolean | null
  herdr: ToolState
  tmux: ToolState
  chrome: ToolState
  magpie: ToolState
  ollama: ToolState
  brew: ToolState
  npm: ToolState
  /** The backend hosting terminals right now; null when it could not be read. */
  host: string | null
  platform: string
}

export const UNKNOWN_FACTS: ToolFacts = {
  claude: 'unknown',
  claudeSignedIn: null,
  codex: 'unknown',
  codexSignedIn: null,
  herdr: 'unknown',
  tmux: 'unknown',
  chrome: 'unknown',
  magpie: 'unknown',
  ollama: 'unknown',
  brew: 'unknown',
  npm: 'unknown',
  host: null,
  platform: 'unknown'
}

export type ToolId = keyof typeof TOOL_COPY

export interface ToolFix {
  label: string
  /** One line for the Setup card. */
  line: string
}

export interface PreflightRow {
  id: ToolId
  name: string
  does: string
  state: ToolState
  /** Never blocks; shown as optional. */
  optional: boolean
  /** The one more thing worth saying, or null. */
  note: string | null
  fix: ToolFix | null
}

const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const CODEX_NPM = 'npm i -g @openai/codex'
const MAGPIE_INSTALL = 'curl -fsSL https://usemagpie.ai/install.sh | sh'
const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

const onMac = (facts: ToolFacts): boolean => facts.platform === 'darwin'
const hasBrew = (facts: ToolFacts): boolean => facts.brew === 'found'

/** The fix that needs Homebrew: it, or the step that gets it. */
function throughBrew(facts: ToolFacts, fix: ToolFix): ToolFix | null {
  if (hasBrew(facts)) return fix
  return onMac(facts) ? { label: FIX_LABELS.HOMEBREW_FIRST, line: HOMEBREW_INSTALL } : null
}

/** The fix for a page to download by hand: Homebrew does it when it is here. */
function brewOrPage(facts: ToolFacts, line: string, page: string): ToolFix | null {
  if (hasBrew(facts)) return { label: FIX_LABELS.INSTALL, line }
  return onMac(facts) ? { label: FIX_LABELS.GET, line: `open ${page}` } : null
}

function installFix(id: ToolId, facts: ToolFacts): ToolFix | null {
  switch (id) {
    case 'claude':
      return { label: FIX_LABELS.INSTALL, line: CLAUDE_INSTALL }
    case 'codex':
      if (facts.npm === 'found') return { label: FIX_LABELS.INSTALL, line: CODEX_NPM }
      return throughBrew(facts, { label: FIX_LABELS.INSTALL, line: 'brew install codex' })
    case 'multiplexer':
      return throughBrew(facts, { label: FIX_LABELS.INSTALL_TMUX, line: 'brew install tmux' })
    case 'chrome':
      return brewOrPage(facts, 'brew install --cask google-chrome', 'https://www.google.com/chrome/')
    case 'magpie':
      return { label: FIX_LABELS.INSTALL, line: MAGPIE_INSTALL }
    case 'ollama':
      return brewOrPage(facts, 'brew install ollama', 'https://ollama.com/download')
  }
}

/** Either keeper will do: found beats unknown, unknown beats missing. */
function eitherState(a: ToolState, b: ToolState): ToolState {
  if (a === 'found' || b === 'found') return 'found'
  return a === 'unknown' || b === 'unknown' ? 'unknown' : 'missing'
}

function row(id: ToolId, state: ToolState, facts: ToolFacts, extra: Partial<Pick<PreflightRow, 'note' | 'fix'>> = {}): PreflightRow {
  return {
    id,
    ...TOOL_COPY[id],
    state,
    optional: id === 'magpie' || id === 'ollama',
    note: extra.note ?? null,
    fix: extra.fix ?? (state === 'missing' ? installFix(id, facts) : null)
  }
}

function agentRow(id: 'claude' | 'codex', state: ToolState, signedIn: boolean | null, loginLine: string, facts: ToolFacts): PreflightRow {
  if (state !== 'found' || signedIn !== false) return row(id, state, facts)
  return row(id, state, facts, { note: TOOL_NOTES.NOT_SIGNED_IN, fix: { label: FIX_LABELS.SIGN_IN, line: loginLine } })
}

function keeperRow(facts: ToolFacts): PreflightRow {
  const state = eitherState(facts.herdr, facts.tmux)
  if (state === 'missing') return row('multiplexer', state, facts, { note: TOOL_NOTES.NOT_KEPT })
  // The host is chosen when the app starts: a keeper installed since then waits for a restart.
  return row('multiplexer', state, facts, state === 'found' && facts.host === 'direct' ? { note: TOOL_NOTES.RESTART } : {})
}

export function preflightRows(facts: ToolFacts): PreflightRow[] {
  return [
    agentRow('claude', facts.claude, facts.claudeSignedIn, 'claude', facts),
    agentRow('codex', facts.codex, facts.codexSignedIn, 'codex login', facts),
    keeperRow(facts),
    row('chrome', facts.chrome, facts),
    row('magpie', facts.magpie, facts),
    row('ollama', facts.ollama, facts)
  ]
}

/** One agent tool is the whole requirement, and a failed check never counts as absent. */
export function mayContinue(rows: readonly PreflightRow[]): boolean {
  return rows.some((r) => (r.id === 'claude' || r.id === 'codex') && r.state !== 'missing')
}
