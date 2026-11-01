// WHAT A NEW AGENT OF EACH HARNESS CAN START ON (owner 2026-11-01: the prompt
// box's tune chip for every harness, not only claude). The shared half
// (shared/launch-tune.ts) spells the flags; this half reads the values each
// harness LISTS ITSELF, because only main has the disk:
//
//   codex     the model catalog config.toml names (model_catalog_json), else
//             ~/.codex/models_cache.json; each model carries its own
//             reasoning levels, and the top-level `model` is the default.
//   pi        pi's own catalogs (pi-catalog.ts, the same reader the live dial
//             uses) and the thinking levels pi allows each model; the default
//             model is settings.json's defaultProvider/defaultModel.
//   opencode  the models opencode.json configures. opencode takes no effort
//             flag, so it offers a model only.
//
// Offering only listed values is the rule the live dials already keep
// (pi-tuning.ts): an unlisted model is a session that cannot start, or a pi
// pane stranded in its model picker. No catalog → no offer → no chip.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { launchOffer, type LaunchOffer } from '../shared/launch-tune'
import { harnessFor } from './harness'
import { piModelFor, piModels, piThinkingLevels, type PiModel } from './pi-catalog'

export interface LaunchOfferOptions {
  /** Test seams; each defaults to where the harness itself looks. */
  codexHome?: string
  piAgentDir?: string
  opencodeConfig?: string
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    // Absent is the normal case for a harness this machine does not use.
    return null
  }
}

function readJson(file: string): unknown {
  const text = readText(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    // A half-written catalog is "we do not know", never "anything goes".
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const expandHome = (file: string): string => (file.startsWith('~/') ? path.join(homedir(), file.slice(2)) : file)

/**
 * Per-model levels, kept only where a model differs from the default's: the
 * offer crosses IPC and HTTP to every prompt box, and most models agree.
 */
function effortOverrides(levelsOf: ReadonlyMap<string, readonly string[]>, base: readonly string[]): Record<string, readonly string[]> {
  const same = (a: readonly string[]): boolean => a.length === base.length && a.every((v, i) => v === base[i])
  return Object.fromEntries([...levelsOf].filter(([, levels]) => !same(levels)))
}

/** A top-level `key = "value"` of a TOML file: the lines above its first [table]. */
function tomlTopString(toml: string, key: string): string | null {
  const top = toml.split(/^\s*\[/m)[0] ?? ''
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(top)
  return match ? match[1] : null
}

function codexLevels(entry: Record<string, unknown>): string[] {
  const raw = entry.supported_reasoning_levels
  if (!Array.isArray(raw)) return []
  return raw.flatMap((level) => {
    const effort = isRecord(level) ? level.effort : level
    return typeof effort === 'string' && effort.length > 0 ? [effort] : []
  })
}

export function codexLaunchOffer(options: LaunchOfferOptions = {}): LaunchOffer | null {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex')
  const config = readText(path.join(home, 'config.toml')) ?? ''
  const pointed = tomlTopString(config, 'model_catalog_json')
  const catalog = readJson(pointed ? expandHome(pointed) : path.join(home, 'models_cache.json'))
  const entries = isRecord(catalog) && Array.isArray(catalog.models) ? catalog.models.filter(isRecord) : []
  const listed = entries.filter((m) => typeof m.slug === 'string' && m.slug.length > 0 && (m.visibility ?? 'list') === 'list')
  if (listed.length === 0) return null
  const levelsOf = new Map(listed.map((m) => [m.slug as string, codexLevels(m)] as const))
  const model = [...levelsOf.keys()]
  const fallback = tomlTopString(config, 'model')
  const effort = levelsOf.get(fallback ?? '') ?? levelsOf.get(model[0]) ?? []
  return { harness: 'codex', model, effort, effortFor: effortOverrides(levelsOf, effort) }
}

function piDefaultModel(agentDir: string, models: readonly PiModel[]): PiModel | null {
  const settings = readJson(path.join(agentDir, 'settings.json'))
  if (!isRecord(settings) || typeof settings.defaultModel !== 'string') return null
  const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null
  const ref = provider ? `${provider}/${settings.defaultModel}` : settings.defaultModel
  return piModelFor(ref, models) ?? piModelFor(settings.defaultModel, models)
}

export function piLaunchOffer(options: LaunchOfferOptions = {}): LaunchOffer | null {
  const agentDir = options.piAgentDir ?? path.join(homedir(), '.pi', 'agent')
  const models = piModels({ agentDir })
  if (models.length === 0) return null
  const levelsOf = new Map(models.map((m) => [m.ref, piThinkingLevels(m)] as const))
  const effort = piThinkingLevels(piDefaultModel(agentDir, models) ?? models[0])
  return { harness: 'pi', model: models.map((m) => m.ref), effort, effortFor: effortOverrides(levelsOf, effort) }
}

export function opencodeLaunchOffer(options: LaunchOfferOptions = {}): LaunchOffer | null {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
  const config = readJson(options.opencodeConfig ?? path.join(configHome, 'opencode', 'opencode.json'))
  const providers = isRecord(config) && isRecord(config.provider) ? config.provider : {}
  const model = Object.entries(providers).flatMap(([provider, value]) =>
    isRecord(value) && isRecord(value.models) ? Object.keys(value.models).map((id) => `${provider}/${id}`) : []
  )
  return model.length > 0 ? { harness: 'opencode', model, effort: [] } : null
}

/** The pick a new agent of this launch command can take, or null (a shell, a team, an unknown harness). */
export function launchOfferFor(command: string, options: LaunchOfferOptions = {}): LaunchOffer | null {
  switch (harnessFor(command)?.id) {
    case 'claude':
      return launchOffer(command)
    case 'codex':
      return codexLaunchOffer(options)
    case 'pi':
      return piLaunchOffer(options)
    case 'opencode':
      return opencodeLaunchOffer(options)
    default:
      return null
  }
}

/**
 * A preset list whose every entry carries its `launch` offer, read when the
 * entry is serialized — so a list handed over once (the phone API's deps)
 * still answers from the catalogs as they are at each request.
 */
export function withLaunchOffers<P extends { command: string }>(
  presets: readonly P[],
  offerOf: (command: string) => LaunchOffer | null = launchOfferFor
): (P & { readonly launch: LaunchOffer | null })[] {
  return presets.map((preset) =>
    Object.defineProperty({ ...preset }, 'launch', { enumerable: true, get: () => offerOf(preset.command) }) as P & {
      readonly launch: LaunchOffer | null
    }
  )
}
