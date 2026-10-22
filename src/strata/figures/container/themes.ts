// A workspace's look from its traits and its name. The theme is the first of
// its traits (words the desktop distils from the owner's brief or the
// project's README), else the first keyword in its name, else a hash; a second
// theme, when there is one, blends a prop or two in. The palette always comes
// from the name. No network, no state: the same input always gets the same table.
import { isWorkspaceTrait, WORKSPACE_TRAITS, type WorkspaceTrait } from '../../../shared/strata'
import { hash } from '../iso/memo'
import { hsl, type Mat } from '../iso/tone'

export const THEMES = WORKSPACE_TRAITS
export type Theme = WorkspaceTrait

/** Words of three letters or fewer match exactly; longer ones also match as a prefix ("play" → "playground"). */
export const KEYWORDS: Record<Theme, readonly string[]> = {
  code: ['dev', 'repo', 'core', 'code', 'src', 'app', 'api', 'build', 'eng', 'hack', 'mono', 'tool', 'kit', 'web'],
  docs: ['note', 'paper', 'thesis', 'doc', 'docs', 'writ', 'research', 'book', 'wiki', 'journal', 'read', 'blog', 'study', 'learn', 'diary'],
  home: ['home', 'house', 'family', 'life', 'personal', 'garden', 'kitchen', 'chore'],
  media: ['media', 'shoot', 'photo', 'video', 'music', 'film', 'record', 'audio', 'site', 'shot', 'promo', 'gallery', 'portfolio'],
  security: ['backup', 'archive', 'vault', 'secret', 'secure', 'safe', 'key', 'keys', 'cold', 'auth'],
  ops: ['ci', 'batch', 'job', 'jobs', 'cron', 'queue', 'night', 'worker', 'runner', 'deploy', 'ops', 'shift'],
  data: ['pipe', 'data', 'etl', 'stream', 'flow', 'ingest', 'sync', 'infra', 'db'],
  play: ['play', 'scratch', 'sandbox', 'throwaway', 'test', 'tmp', 'temp', 'toy', 'try', 'demo', 'spike', 'game'],
  design: ['craft', 'design', 'art', 'brand', 'ui', 'ux', 'figma', 'sketch', 'draw', 'studio'],
  ai: ['llm', 'ai', 'ml', 'lab', 'model', 'gpt', 'agent', 'eval', 'train', 'prompt'],
  team: ['team', 'crew', 'squad', 'org', 'club', 'group', 'guild', 'party']
}

/** Lowercase words, split on anything not a letter or digit and on camelCase. */
export const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const matches = (word: string, key: string) => word === key || (key.length >= 4 && word.startsWith(key))

const named = (name: string): Theme[] =>
  wordsOf(name).flatMap((word) => {
    const hit = THEMES.find((t) => KEYWORDS[t].some((key) => matches(word, key)))
    return hit ? [hit] : []
  })

/** The table's themes, strongest first: one or two, never none. */
export const themesOf = (name: string, traits: readonly string[] = []): Theme[] => {
  const all = [...traits.filter(isWorkspaceTrait), ...named(name)]
  const unique = all.filter((t, i) => all.indexOf(t) === i).slice(0, 2)
  return unique.length ? unique : [THEMES[hash(name.trim().toLowerCase()) % THEMES.length]]
}

/** Ten hand-picked hues so every palette sits with colorfigures' own. */
const HUES = [8, 24, 42, 140, 168, 198, 222, 262, 300, 340]

export const paletteOf = (name: string): Mat => {
  const h = HUES[hash('palette:' + name.trim().toLowerCase()) % HUES.length]
  return { l: hsl(h, 0.58, 0.7), m: hsl(h, 0.44, 0.57), d: hsl(h, 0.4, 0.25) }
}

/** The name as it fits on a plaque: trimmed, one line, cut with an ellipsis. */
export const plaqueText = (name: string, max: number): string => {
  // by code point, so a cut never splits an emoji's surrogate pair
  const flat = Array.from(name.replace(/\s+/g, ' ').trim())
  return flat.length <= max ? flat.join('') : flat.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…'
}
