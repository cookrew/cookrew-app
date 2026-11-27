// THE MODELS A NEW ANTIGRAVITY CARD CAN START ON (launch offers, P2).
//
// agy keeps no local model catalog: `agy models` asks Google every time
// (7.6 s measured 2026-11-27) and prints `<slug>\t<label>` rows such as
// `gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)`. A slug's last word is
// its effort when it is one of agy's levels; agy takes the bare model with
// `--effort <level>` as well, so the offer lists bare models and each one's
// own levels. The list is cached in ~/.cookrew/agy-models.json and refreshed
// in the background (model-list-cache.ts).

import type { LaunchOffer } from '../shared/launch-tune'
import { cachedModelSlugs, modelCacheFile, validModelSlug, type ModelCacheOptions, type ModelListSource } from './model-list-cache'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type AgyModelOptions = ModelCacheOptions

export const defaultAgyModelCache = (): string => modelCacheFile('agy')

/** The slugs `agy models` printed, in its order. */
export function agySlugsOf(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.split('\t')[0]?.trim() ?? '')
    .filter(validModelSlug)
}

/** Bare models, in first-seen order, each with the levels its slugs carry. */
export function agyOfferOf(slugs: readonly string[]): LaunchOffer | null {
  const levelsOf = new Map<string, string[]>()
  for (const slug of slugs) {
    const cut = slug.lastIndexOf('-')
    const tail = cut > 0 ? slug.slice(cut + 1) : ''
    const isLevel = (LEVELS as readonly string[]).includes(tail)
    const model = isLevel ? slug.slice(0, cut) : slug
    const levels = levelsOf.get(model) ?? []
    if (isLevel && !levels.includes(tail)) levels.push(tail)
    levelsOf.set(model, levels)
  }
  if (levelsOf.size === 0) return null
  const ordered = (levels: readonly string[]): string[] => LEVELS.filter((level) => levels.includes(level))
  const model = [...levelsOf.keys()]
  const effort = ordered(levelsOf.get(model[0]) ?? [])
  const effortFor = Object.fromEntries(
    [...levelsOf].map(([name, levels]) => [name, ordered(levels)] as const).filter(([, levels]) => levels.join() !== effort.join())
  )
  return { harness: 'agy', model, effort, effortFor }
}

const AGY_MODELS: ModelListSource = { bin: 'agy', args: ['models'], env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, parse: agySlugsOf }

/** The offer from the cache (null until the first refresh lands); a stale or missing cache starts one. */
export function agyLaunchOffer(options: AgyModelOptions = {}): LaunchOffer | null {
  const slugs = cachedModelSlugs(AGY_MODELS, defaultAgyModelCache(), options)
  return slugs ? agyOfferOf(slugs) : null
}
