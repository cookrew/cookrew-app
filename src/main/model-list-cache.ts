// A HARNESS'S MODEL LIST, CACHED (launch offers). Some harnesses keep no local
// model catalog and ask their vendor each time (`agy models` 7.6 s, `devin
// models list` 5.4 s, measured 2026-11-27). The list is cached under
// ~/.cookrew/<name>-models.json and refreshed in the background, never on the
// thread a menu opens on; a missing or stale cache answers with what it has.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'

const REFRESH_MS = 6 * 60 * 60 * 1000
// A model id as a harness names it: providers and models, dots, dashes and
// one colon (Alma's `<providerId>:<model>`).
const SLUG_RE = /^[a-z0-9][a-z0-9.:_-]{0,127}$/

export interface ModelCache {
  at: number
  slugs: string[]
}

export interface ModelListSource {
  /** The CLI and its arguments that print the list. */
  bin: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
  /** The slugs that output names, in its order. */
  parse: (output: string) => string[]
}

export interface ModelCacheOptions {
  cacheFile?: string
  now?: () => number
  /** Starts a refresh; the default runs the source's command and writes the cache. */
  refresh?: (cacheFile: string) => void
}

export const modelCacheFile = (name: string): string => path.join(homedir(), '.cookrew', `${name}-models.json`)

export const validModelSlug = (slug: unknown): slug is string => typeof slug === 'string' && SLUG_RE.test(slug)

function readCache(file: string): ModelCache | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelCache>
    if (typeof value.at !== 'number' || !Array.isArray(value.slugs)) return null
    return { at: value.at, slugs: value.slugs.filter(validModelSlug) }
  } catch {
    return null
  }
}

const refreshing = new Set<string>()

function refreshBy(source: ModelListSource, cacheFile: string): void {
  if (refreshing.has(cacheFile)) return
  refreshing.add(cacheFile)
  execFile(source.bin, [...source.args], { timeout: 60_000, env: { ...process.env, ...source.env } }, (error, stdout) => {
    refreshing.delete(cacheFile)
    if (error) return
    const slugs = source.parse(String(stdout)).filter(validModelSlug)
    if (slugs.length === 0) return
    try {
      writeFileAtomic(cacheFile, `${JSON.stringify({ at: Date.now(), slugs } satisfies ModelCache)}\n`)
    } catch (writeError) {
      console.error(`${source.bin} model list could not be cached:`, writeError)
    }
  })
}

/** The cached slugs (null until a first refresh lands); a stale or missing cache starts a refresh. */
export function cachedModelSlugs(source: ModelListSource, defaultFile: string, options: ModelCacheOptions = {}): string[] | null {
  const cacheFile = options.cacheFile ?? defaultFile
  const now = options.now ?? Date.now
  const cache = readCache(cacheFile)
  if (cache === null || now() - cache.at > REFRESH_MS) (options.refresh ?? ((file) => refreshBy(source, file)))(cacheFile)
  return cache ? cache.slugs : null
}
