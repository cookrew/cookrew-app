// THE HARNESS CATALOG (harness-integration-contract, P0 of the 2026-11-25
// harness expansion): the one ordered list of agent harnesses Cookrew runs,
// importable from main, renderer and tests alike. Every per-harness union in
// the app (the registry's id, trace sources, launch harnesses, routing rows,
// fleet and sprite kinds) is derived from HARNESS_IDS, so adding a harness is
// one line here — and every feature table keyed by HarnessId then refuses to
// compile until it says what that harness does (harness-support.ts).

export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi', 'agy', 'devin', 'dsh', 'alma'] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

/** What the person reads: dock, routing panel, first-run, Sous. */
export const HARNESS_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  agy: 'Antigravity CLI',
  devin: 'Devin',
  dsh: 'DeepSeek Harness',
  alma: 'Alma'
} as const satisfies Record<HarnessId, string>

export type HarnessName = (typeof HARNESS_NAMES)[HarnessId]

/** Display facts the renderer needs without reaching into main. */
export interface HarnessCard {
  id: HarnessId
  name: HarnessName
  /** The executable a launch line starts with. */
  bin: string
  /**
   * A preset NAME that draws this harness's mark and sprite (renderer has the
   * preset's name, not its command). Tried in catalog order, so a broader
   * pattern must come later.
   */
  presetPattern: RegExp
  /** True when a launch command runs this harness (the registry's `matches`). */
  matches: (command: string) => boolean
  /**
   * The agent kind herdr's own status detector knows this harness by (its
   * manifest id under ~/.local/state/herdr/agent-detection). Not always the
   * launch binary: a `*-pi` wrapper such as `qwen-pi` is the pi harness, and a
   * pane labelled `qwen-pi` would get no detector at all.
   */
  herdrKind: string
}

/** A line that runs Cookrew's ACP host on this agent: `cookrew-acp dsh …`, by name or by path. */
const hostedLaunch = (agent: string): ((command: string) => boolean) => {
  const re = new RegExp(`^\\s*(?:\\S*/)?cookrew-acp\\s+${agent}(?:\\s|$)`)
  return (command) => re.test(command)
}

/** A launch line whose first word is exactly `bin` (`claude …`, `codex resume …`). */
const leadingWord = (bin: string): ((command: string) => boolean) => {
  const re = new RegExp(`^\\s*${bin}\\b`)
  return (command) => re.test(command)
}

/**
 * Pi is the first token's BASENAME: a bare `pi`, or a wrapper named `*-pi`
 * (~/.cookrew/bin/qwen-pi). A wrapper IS the pi harness, and every gate on
 * the pi path keys off this one predicate. Matching only a literal leading
 * `pi` left wrapper terminals half-alive (Pilot, 2026-08-27): no session file
 * bound, empty transcript slots, the session in pi's shared cwd store.
 */
export function isPiLaunch(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.slice(first.lastIndexOf('/') + 1)
  return base === 'pi' || base.endsWith('-pi')
}

export const HARNESS_CARDS: Readonly<Record<HarnessId, HarnessCard>> = {
  claude: { id: 'claude', name: HARNESS_NAMES.claude, bin: 'claude', presetPattern: /claude/i, matches: leadingWord('claude'), herdrKind: 'claude' },
  codex: { id: 'codex', name: HARNESS_NAMES.codex, bin: 'codex', presetPattern: /codex/i, matches: leadingWord('codex'), herdrKind: 'codex' },
  opencode: { id: 'opencode', name: HARNESS_NAMES.opencode, bin: 'opencode', presetPattern: /opencode/i, matches: leadingWord('opencode'), herdrKind: 'opencode' },
  pi: { id: 'pi', name: HARNESS_NAMES.pi, bin: 'pi', presetPattern: /^pi$|^pi |pi agent|^pi-agent$/i, matches: isPiLaunch, herdrKind: 'pi' },
  // herdr's own manifest id is `agy` (aliases antigravity, antigravity-cli), measured on herdr 0.9.5.
  agy: { id: 'agy', name: HARNESS_NAMES.agy, bin: 'agy', presetPattern: /antigravity|^agy\b/i, matches: leadingWord('agy'), herdrKind: 'agy' },
  // herdr 0.9.5 ships a `devin` detector (agent-detection/remote/devin.toml).
  devin: { id: 'devin', name: HARNESS_NAMES.devin, bin: 'devin', presetPattern: /devin/i, matches: leadingWord('devin'), herdrKind: 'devin' },
  // No terminal UI of its own: Cookrew's ACP host runs it in the pane (cli/cookrew-acp.mjs).
  // herdr has no detector for it; the host reports its state.
  dsh: { id: 'dsh', name: HARNESS_NAMES.dsh, bin: 'dsh', presetPattern: /deepseek|^dsh\b/i, matches: hostedLaunch('dsh'), herdrKind: 'dsh' },
  // A stateful server on this machine: Cookrew's host drives its API (cli/host/alma.mjs).
  // herdr has no detector for it; the host reports its state.
  alma: { id: 'alma', name: HARNESS_NAMES.alma, bin: 'alma', presetPattern: /^alma\b/i, matches: hostedLaunch('alma'), herdrKind: 'alma' }
}

/** The harness a launch command runs, or null (a plain shell, an unknown binary). Main and renderer alike. */
export function harnessOfCommand(command: string): HarnessId | null {
  return HARNESS_IDS.find((id) => HARNESS_CARDS[id].matches(command)) ?? null
}

/** The harness a preset's name draws, or null (a shell, a custom preset). */
export function harnessOfPreset(preset: string | null | undefined): HarnessId | null {
  const name = preset ?? ''
  return HARNESS_IDS.find((id) => HARNESS_CARDS[id].presetPattern.test(name)) ?? null
}

const ID_SET: ReadonlySet<string> = new Set(HARNESS_IDS)

/** True for a known harness id — the check every wire value goes through. */
export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && ID_SET.has(value)
}
