// THE MODELS A NEW ANTIGRAVITY CARD CAN START ON (launch offers, P2).
//
// agy keeps no local model catalog: `agy models` asks Google every time
// (7.6 s measured 2026-11-27) and prints `<slug>\t<label>` rows such as
// `gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)`. A slug's last word is
// its effort when it is one of agy's levels; agy takes the bare model with
// `--effort <level>` as well, so the offer lists bare models and each one's
// own levels. The list is cached in ~/.cookrew/agy-models.json and refreshed
// in the background, never on the thread a menu opens on.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { LaunchOffer } from '../shared/launch-tune'
import { writeFileAtomic } from './atomic-file'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const REFRESH_MS = 6 * 60 * 60 * 1000
const SLUG_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/

export interface AgyModelCache {
  at: number
  slugs: string[]
}

export interface AgyModelOptions {
  cacheFile?: string
  now?: () => number
  /** Starts a refresh; the default runs `agy models` and writes the cache. */
  refresh?: (cacheFile: string) => void
}

export const defaultAgyModelCache = (): string => path.join(homedir(), '.cookrew', 'agy-models.json')

/** The slugs `agy models` printed, in its order. */
export function agySlugsOf(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.split('\t')[0]?.trim() ?? '')
    .filter((slug) => SLUG_RE.test(slug))
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

function readCache(file: string): AgyModelCache | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<AgyModelCache>
    if (typeof value.at !== 'number' || !Array.isArray(value.slugs)) return null
    return { at: value.at, slugs: value.slugs.filter((slug): slug is string => typeof slug === 'string' && SLUG_RE.test(slug)) }
  } catch {
    return null
  }
}

let refreshing = false

function refreshByAgy(cacheFile: string): void {
  if (refreshing) return
  refreshing = true
  execFile('agy', ['models'], { timeout: 60_000, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } }, (error, stdout) => {
    refreshing = false
    if (error) return
    const slugs = agySlugsOf(String(stdout))
    if (slugs.length === 0) return
    try {
      writeFileAtomic(cacheFile, `${JSON.stringify({ at: Date.now(), slugs } satisfies AgyModelCache)}\n`)
    } catch (writeError) {
      console.error('Antigravity model list could not be cached:', writeError)
    }
  })
}

/** The offer from the cache (null until the first refresh lands); a stale or missing cache starts one. */
export function agyLaunchOffer(options: AgyModelOptions = {}): LaunchOffer | null {
  const cacheFile = options.cacheFile ?? defaultAgyModelCache()
  const now = options.now ?? Date.now
  const cache = readCache(cacheFile)
  if (cache === null || now() - cache.at > REFRESH_MS) (options.refresh ?? refreshByAgy)(cacheFile)
  return cache ? agyOfferOf(cache.slugs) : null
}
