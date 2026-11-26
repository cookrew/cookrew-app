// THE HARNESS CATALOG (harness-integration-contract, P0 of the 2026-11-25
// harness expansion): the one ordered list of agent harnesses Cookrew runs,
// importable from main, renderer and tests alike. Every per-harness union in
// the app (the registry's id, trace sources, launch harnesses, routing rows,
// fleet and sprite kinds) is derived from HARNESS_IDS, so adding a harness is
// one line here — and every feature table keyed by HarnessId then refuses to
// compile until it says what that harness does (harness-support.ts).

export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

/** What the person reads: dock, routing panel, first-run, Sous. */
export const HARNESS_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi'
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
}

export const HARNESS_CARDS: Readonly<Record<HarnessId, HarnessCard>> = {
  claude: { id: 'claude', name: HARNESS_NAMES.claude, bin: 'claude', presetPattern: /claude/i },
  codex: { id: 'codex', name: HARNESS_NAMES.codex, bin: 'codex', presetPattern: /codex/i },
  opencode: { id: 'opencode', name: HARNESS_NAMES.opencode, bin: 'opencode', presetPattern: /opencode/i },
  pi: { id: 'pi', name: HARNESS_NAMES.pi, bin: 'pi', presetPattern: /^pi$|^pi |pi agent|^pi-agent$/i }
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
