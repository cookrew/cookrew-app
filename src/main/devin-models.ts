// THE MODELS A NEW DEVIN CARD CAN START ON (launch offers, P3).
//
// `devin models list --format json` prints families, each with variants
// whose `model_uid` is what `--model` takes (`swe-2-1-medium`, `adaptive`).
// Devin has no effort flag at launch: a variant's level is part of its uid,
// so the offer lists every variant as a model and no effort dial.

import type { LaunchOffer } from '../shared/launch-tune'
import { cachedModelSlugs, modelCacheFile, type ModelCacheOptions, type ModelListSource } from './model-list-cache'

/** Every variant's model uid, in Devin's order. */
export function devinSlugsOf(output: string): string[] {
  try {
    const value = JSON.parse(output) as { families?: Array<{ variants?: Array<{ model_uid?: unknown }> }> }
    return (value.families ?? []).flatMap((family) => (family.variants ?? []).flatMap((v) => (typeof v.model_uid === 'string' ? [v.model_uid] : [])))
  } catch {
    return []
  }
}

const DEVIN_MODELS: ModelListSource = { bin: 'devin', args: ['models', 'list', '--format', 'json'], parse: devinSlugsOf }

export const defaultDevinModelCache = (): string => modelCacheFile('devin')

export function devinLaunchOffer(options: ModelCacheOptions = {}): LaunchOffer | null {
  const slugs = cachedModelSlugs(DEVIN_MODELS, defaultDevinModelCache(), options)
  return slugs && slugs.length > 0 ? { harness: 'devin', model: [...new Set(slugs)], effort: [] } : null
}
