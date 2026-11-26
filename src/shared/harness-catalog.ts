// THE HARNESS CATALOG (harness-integration-contract, P0 of the 2026-11-25
// harness expansion): the one ordered list of agent harnesses Cookrew runs,
// importable from main, renderer and tests alike. Every per-harness union in
// the app (the registry's id, trace sources, launch harnesses, routing rows,
// fleet and sprite kinds) is derived from HARNESS_IDS, so adding a harness is
// one line here — and every feature table keyed by HarnessId then refuses to
// compile until it says what that harness does (harness-support.ts).

export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

/** Display facts the renderer needs without reaching into main. */
export interface HarnessCard {
  id: HarnessId
  /** What the person reads: dock, routing panel, first-run. */
  name: string
  /** The executable a launch line starts with. */
  bin: string
}

export const HARNESS_CARDS: Readonly<Record<HarnessId, HarnessCard>> = {
  claude: { id: 'claude', name: 'Claude Code', bin: 'claude' },
  codex: { id: 'codex', name: 'Codex', bin: 'codex' },
  opencode: { id: 'opencode', name: 'OpenCode', bin: 'opencode' },
  pi: { id: 'pi', name: 'Pi', bin: 'pi' }
}

const ID_SET: ReadonlySet<string> = new Set(HARNESS_IDS)

/** True for a known harness id — the check every wire value goes through. */
export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && ID_SET.has(value)
}
