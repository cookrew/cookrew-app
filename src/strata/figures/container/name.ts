// A workspace's look from its name alone: archetype by a keyword map (first
// word that matches wins), else by hash; palette by hash. No network, no
// state: the same name always gets the same furniture.
import { hash } from '../iso/memo'
import { hsl, type Mat } from '../iso/tone'

export const ARCHETYPES = [
  'workbench',
  'bookshelf',
  'house',
  'crate',
  'vault',
  'lockers',
  'pipes',
  'sandbox',
  'drawers',
  'lab',
  'bleachers'
] as const
export type Archetype = (typeof ARCHETYPES)[number]

/** Words of three letters or fewer match exactly; longer ones also match as a prefix ("play" → "playground"). */
export const KEYWORDS: Record<Archetype, readonly string[]> = {
  workbench: ['dev', 'repo', 'core', 'code', 'src', 'app', 'api', 'build', 'eng', 'hack', 'mono', 'tool', 'kit', 'web'],
  bookshelf: ['note', 'paper', 'thesis', 'doc', 'docs', 'writ', 'research', 'book', 'wiki', 'journal', 'read', 'blog', 'study', 'learn'],
  house: ['home', 'house', 'family', 'life', 'personal', 'garden', 'kitchen', 'chore'],
  crate: ['media', 'shoot', 'photo', 'video', 'music', 'film', 'record', 'audio', 'site', 'shot', 'promo', 'gallery', 'portfolio'],
  vault: ['backup', 'archive', 'vault', 'secret', 'secure', 'safe', 'key', 'keys', 'cold'],
  lockers: ['ci', 'batch', 'job', 'jobs', 'cron', 'queue', 'night', 'worker', 'runner', 'deploy', 'ops', 'shift'],
  pipes: ['pipe', 'data', 'etl', 'stream', 'flow', 'ingest', 'sync', 'infra'],
  sandbox: ['play', 'scratch', 'sandbox', 'throwaway', 'test', 'tmp', 'temp', 'toy', 'try', 'demo', 'spike'],
  drawers: ['craft', 'design', 'art', 'brand', 'ui', 'ux', 'figma', 'sketch', 'draw', 'studio'],
  lab: ['llm', 'ai', 'ml', 'lab', 'model', 'gpt', 'agent', 'eval', 'train', 'prompt'],
  bleachers: ['team', 'crew', 'squad', 'org', 'club', 'group', 'guild', 'party']
}

/** Lowercase words, split on anything not a letter or digit and on camelCase. */
export const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const matches = (word: string, key: string) => word === key || (key.length >= 4 && word.startsWith(key))

export const archetypeOf = (name: string): Archetype => {
  for (const word of wordsOf(name)) {
    const hit = ARCHETYPES.find((a) => KEYWORDS[a].some((key) => matches(word, key)))
    if (hit) return hit
  }
  return ARCHETYPES[hash(name.trim().toLowerCase()) % ARCHETYPES.length]
}

/** Ten hand-picked hues so every palette sits with colorfigures' own. */
const HUES = [8, 24, 42, 140, 168, 198, 222, 262, 300, 340]

export const paletteOf = (name: string): Mat => {
  const h = HUES[hash('palette:' + name.trim().toLowerCase()) % HUES.length]
  return { l: hsl(h, 0.58, 0.7), m: hsl(h, 0.44, 0.57), d: hsl(h, 0.4, 0.25) }
}

/** The name as it fits on a plaque: trimmed, one line, cut with an ellipsis. */
export const plaqueText = (name: string, max: number): string => {
  const flat = name.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, Math.max(1, max - 1)).trimEnd() + '…'
}
