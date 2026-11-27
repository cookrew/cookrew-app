// THE MODELS A NEW ALMA CARD CAN START ON (launch offers, P5).
//
// Alma keeps its providers, so its model ids are `<providerId>:<model>`,
// listed at GET /api/models (measured 2026-11-27 on the owner's app). The
// route's own provider is there too (Magpie's `group/smart`). The list is
// cached in ~/.cookrew/alma-models.json and refreshed in the background, with
// `curl` — the host runs a short-lived local server call, never a browser.

import type { LaunchOffer } from '../shared/launch-tune'
import { cachedModelSlugs, modelCacheFile, type ModelCacheOptions, type ModelListSource } from './model-list-cache'

/** Alma's ids, `<providerId>:<model>`, from GET /api/models. */
export function almaSlugsOf(output: string): string[] {
  try {
    const value = JSON.parse(output) as { data?: Array<{ providerId?: unknown; id?: unknown }> }
    return (value.data ?? []).flatMap((m) => (typeof m.providerId === 'string' && typeof m.id === 'string' ? [`${m.providerId}:${m.id}`] : []))
  } catch {
    return []
  }
}

export function defaultAlmaModelCache(): string {
  return modelCacheFile('alma')
}

export function almaModelSource(baseUrl = process.env.ALMA_API_URL ?? 'http://127.0.0.1:23001'): ModelListSource {
  return { bin: 'curl', args: ['-s', '--max-time', '10', `${baseUrl.replace(/\/+$/, '')}/api/models`], parse: almaSlugsOf }
}

export function almaLaunchOffer(options: ModelCacheOptions & { baseUrl?: string } = {}): LaunchOffer | null {
  const slugs = cachedModelSlugs(almaModelSource(options.baseUrl), defaultAlmaModelCache(), options)
  // Alma ids carry a provider prefix's colon; the cache's alphabet allows it.
  return slugs && slugs.length > 0 ? { harness: 'alma', model: [...new Set(slugs)], effort: [] } : null
}
