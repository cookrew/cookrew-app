// PI'S OWN MODEL CATALOGS, read from disk.
//
// Pi answers `/model <id>` with an exact match by setting the model, and
// answers anything else by OPENING A PICKER that swallows every keystroke
// after it. So a dial that offered a guessed list would, on its first miss,
// strand the pane in a modal — the readout would still look fine and the agent
// would be unreachable. The only safe list is the one pi itself holds.
//
// Two files, both pi's:
//   ~/.pi/agent/models.json        the providers the owner configured, each
//                                  with its models — this is what /model
//                                  matches against
//   ~/.pi/agent/models-store.json  the downloaded catalogs, which carry the
//                                  `reasoning` flag and `thinkingLevelMap`
//                                  that decide which thinking levels a model
//                                  actually supports
//
// NOTHING ELSE IS READ FROM THEM. models.json holds an `apiKey` field whose
// value is a shell command that prints a secret; this takes ids and names and
// never touches it.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Pi's own EXTENDED_THINKING_LEVELS, in its order. */
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export interface PiModel {
  /** The exact string `/model` matches — `provider/id`. */
  ref: string
  id: string
  provider: string
  reasoning: boolean
  /** Per-level override map; a null entry means the level is unsupported. */
  thinkingLevelMap?: Record<string, string | null>
}

export interface PiCatalogOptions {
  /** Override for tests; defaults to ~/.pi/agent. */
  agentDir?: string
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A missing or half-written catalog is "we do not know pi's models", which
    // the caller turns into an empty dial rather than a guessed one.
    return null
  }
}

function agentDir(options: PiCatalogOptions): string {
  return options.agentDir ?? path.join(homedir(), '.pi', 'agent')
}

/**
 * The models this machine's pi will accept, newest configuration first.
 * Empty when the catalog cannot be read — which the dial reports as "no
 * choices", never as "any string will do".
 */
export function piModels(options: PiCatalogOptions = {}): PiModel[] {
  const configured = readJson(path.join(agentDir(options), 'models.json'))
  const providers =
    typeof configured === 'object' && configured !== null
      ? (configured as { providers?: unknown }).providers
      : null
  if (typeof providers !== 'object' || providers === null) return []

  // The downloaded catalogs are the only place `reasoning` lives, and pi keys
  // them by provider then looks up by model id.
  const store = readJson(path.join(agentDir(options), 'models-store.json'))
  const storeOf = (provider: string, id: string): Record<string, unknown> | null => {
    if (typeof store !== 'object' || store === null) return null
    const bucket = (store as Record<string, unknown>)[provider]
    if (typeof bucket !== 'object' || bucket === null) return null
    const models = (bucket as { models?: unknown }).models
    if (!Array.isArray(models)) return null
    const hit = models.find((m) => typeof m === 'object' && m !== null && (m as { id?: unknown }).id === id)
    return (hit as Record<string, unknown>) ?? null
  }

  const out: PiModel[] = []
  for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
    const models = typeof value === 'object' && value !== null ? (value as { models?: unknown }).models : null
    if (!Array.isArray(models)) continue
    for (const entry of models) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = (entry as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) continue
      const extra = storeOf(provider, id)
      const reasoning = Boolean(
        (entry as { reasoning?: unknown }).reasoning ?? extra?.reasoning ?? false
      )
      const map =
        ((entry as { thinkingLevelMap?: unknown }).thinkingLevelMap ??
          extra?.thinkingLevelMap) as Record<string, string | null> | undefined
      out.push({ ref: `${provider}/${id}`, id, provider, reasoning, thinkingLevelMap: map })
    }
  }
  return out
}

/**
 * The thinking levels a model supports, reimplementing pi's own rule exactly
 * (getSupportedThinkingLevels): a model without reasoning has only `off`; one
 * with it takes every level except those its map sends to null, and `xhigh`
 * and `max` only when the map names them.
 *
 * Verified against the real thing: `/thinking high` on qwen3.8-27b-q8 answers
 * "Unknown thinking level. Available levels: off." — which is what this
 * returns for a model with no reasoning flag.
 */
export function piThinkingLevels(model: PiModel | null): string[] {
  if (model === null || !model.reasoning) return ['off']
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true
  })
}

/** The catalog entry a recorded model id belongs to, or null. */
export function piModelFor(recorded: string | null, models: readonly PiModel[]): PiModel | null {
  if (recorded === null) return null
  return models.find((m) => m.id === recorded || m.ref === recorded) ?? null
}
