// A WORKSPACE'S TRAITS: at most TRAITS_MAX words of the closed list in
// shared/fleet.ts, strongest first, that cookrew.dev themes its table from.
//
// Read, in this order:
//   - the owner's brief (WorkspaceMeta.brief), when it says anything;
//   - else the PRIMARY dir's package.json (name, description, keywords and
//     dependency names) and README.md (first 8 KB).
// Never the workspace name: the view reads the name itself.
//
// PRIVACY: what leaves this module is words of WORKSPACE_TRAITS and nothing
// else. Text is tokenised and scored where it is read; the cache holds scores,
// never text.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceMeta } from '../../shared/model'
import { TRAITS_MAX, WORKSPACE_TRAITS, type WorkspaceTrait } from '../../shared/fleet'

const KEYWORDS: Readonly<Record<WorkspaceTrait, readonly string[]>> = {
  code: [
    'code', 'repo', 'app', 'api', 'sdk', 'cli', 'library', 'libraries', 'framework', 'typescript', 'javascript',
    'react', 'electron', 'server', 'compiler', 'rust', 'python', 'golang', 'node', 'nodejs', 'npm', 'frontend',
    'backend', 'monorepo', 'plugin', 'extension', 'vite', 'webpack', 'swift', 'kotlin', 'java'
  ],
  docs: [
    'docs', 'documentation', 'notes', 'wiki', 'blog', 'writing', 'research', 'paper', 'thesis', 'book', 'journal',
    'essay', 'markdown', 'obsidian', 'manuscript'
  ],
  home: [
    'home', 'family', 'personal', 'garden', 'recipe', 'kitchen', 'household', 'homelab', 'homekit', 'chores',
    'groceries', 'travel'
  ],
  media: [
    'video', 'audio', 'photo', 'music', 'film', 'podcast', 'image', 'camera', 'stream', 'streaming', 'media',
    'ffmpeg', 'codec', 'youtube', 'sound'
  ],
  security: [
    'security', 'auth', 'crypto', 'encryption', 'secret', 'vault', 'backup', 'password', 'keys', 'oauth', 'pentest',
    'firewall', 'privacy', 'passkey'
  ],
  ops: [
    'ci', 'deploy', 'kubernetes', 'k8s', 'docker', 'terraform', 'cron', 'infra', 'monitoring', 'ops', 'devops',
    'runner', 'batch', 'helm', 'ansible', 'nginx', 'datadog', 'grafana', 'prometheus', 'sre', 'observability'
  ],
  data: [
    'data', 'etl', 'pipeline', 'database', 'sql', 'analytics', 'warehouse', 'ingest', 'dataset', 'postgres', 'sqlite',
    'duckdb', 'spark', 'pandas', 'chart', 'dashboard', 'metrics'
  ],
  play: [
    'demo', 'playground', 'sandbox', 'experiment', 'prototype', 'prototyping', 'toy', 'scratch', 'spike', 'game', 'fun',
    'hackathon', 'puzzle'
  ],
  design: [
    'design', 'figma', 'ui', 'ux', 'brand', 'css', 'scss', 'illustration', 'font', 'sketch', 'logo', 'typography',
    'mockup', 'wireframe', 'tailwind'
  ],
  ai: [
    'ai', 'llm', 'agent', 'agents', 'claude', 'openai', 'model', 'prompt', 'embedding', 'ml', 'eval', 'gpt',
    'anthropic', 'ollama', 'langchain', 'neural', 'pytorch', 'tensorflow', 'inference'
  ],
  team: [
    'team', 'community', 'org', 'organization', 'organisation', 'collaboration', 'collaborative', 'crew', 'club',
    'members', 'onboarding'
  ]
}

/** A keyword this long also matches as a prefix ("deploy" → "deployment"). */
const PREFIX_MIN = 4

/** Words that start like a keyword and mean something else; they never match by prefix. */
const FALSE_FRIENDS = ['author', 'homepage', 'homebrew', 'demonstr', 'bookmark', 'booking', 'keystroke', 'report']

/** keyword (and keyword + 's') → trait. */
const EXACT: ReadonlyMap<string, WorkspaceTrait> = new Map(
  WORKSPACE_TRAITS.flatMap((trait) => KEYWORDS[trait].flatMap((word) => [[word, trait], [`${word}s`, trait]] as const))
)

const PREFIXES: ReadonlyArray<readonly [string, WorkspaceTrait]> = WORKSPACE_TRAITS.flatMap((trait) =>
  KEYWORDS[trait].filter((word) => word.length >= PREFIX_MIN).map((word) => [word, trait] as const)
)

/** A trait needs at least this score... */
export const TRAIT_FLOOR = 2
/** ...and at least 1/TRAIT_RATIO of the strongest one's. */
export const TRAIT_RATIO = 4

/**
 * Text is cut into runs at whitespace and brackets, which no address spans,
 * and every pattern below runs on one run at a time. A run longer than this is
 * a hash, a data URL or a run-on, never a word about the project; dropping it
 * keeps the work linear in the text, however hostile the file.
 */
export const RUN_MAX = 64
const RUN_BREAK = /[\s()[\]{}<>"'`]+/

/** Addresses are not words about the project: a host's "org" or "ai" is no signal. */
const isAddress = (run: string): boolean => run.includes('://') || run.indexOf('@', 1) !== -1
const HOST = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|sh|me|gg|xyz)\b\S*/gi

const wordsOf = (run: string): string[] =>
  run
    .replace(HOST, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)

/** Lowercase words: addresses and over-long runs dropped, camelCase and acronyms split, anything not a letter or digit a break. */
export function tokensOf(text: string): string[] {
  return text
    .split(RUN_BREAK)
    .filter((run) => run.length > 0 && run.length <= RUN_MAX && !isAddress(run))
    .flatMap(wordsOf)
}

/** The traits one word speaks for: an exact keyword wins, else every keyword it starts with. */
function traitsOfToken(token: string): readonly WorkspaceTrait[] {
  const exact = EXACT.get(token)
  if (exact) return [exact]
  if (FALSE_FRIENDS.some((friend) => token.startsWith(friend))) return []
  const found = PREFIXES.filter(([word]) => token.startsWith(word)).map(([, trait]) => trait)
  return [...new Set(found)]
}

export type TraitScores = Readonly<Partial<Record<WorkspaceTrait, number>>>

/** Hits per trait, each capped at `cap` and times `weight`. Only traits that scored are present. */
export function scoreText(text: string, weight = 1, cap = Number.POSITIVE_INFINITY): TraitScores {
  const hits = new Map<WorkspaceTrait, number>()
  for (const token of tokensOf(text)) {
    for (const trait of traitsOfToken(token)) hits.set(trait, (hits.get(trait) ?? 0) + 1)
  }
  return Object.fromEntries(
    WORKSPACE_TRAITS.flatMap((trait): Array<[WorkspaceTrait, number]> => {
      const count = hits.get(trait) ?? 0
      return count > 0 ? [[trait, Math.min(count, cap) * weight]] : []
    })
  )
}

export function addScores(...all: readonly TraitScores[]): TraitScores {
  return Object.fromEntries(
    WORKSPACE_TRAITS.flatMap((trait): Array<[WorkspaceTrait, number]> => {
      const total = all.reduce((sum, scores) => sum + (scores[trait] ?? 0), 0)
      return total > 0 ? [[trait, total]] : []
    })
  )
}

/** Strongest first, ties in WORKSPACE_TRAITS order; weak noise dropped; at most TRAITS_MAX. */
export function rankTraits(scores: TraitScores): WorkspaceTrait[] {
  const scored = WORKSPACE_TRAITS.map((trait) => ({ trait, score: scores[trait] ?? 0 }))
  const top = Math.max(0, ...scored.map((s) => s.score))
  return scored
    .filter((s) => s.score >= TRAIT_FLOOR && s.score * TRAIT_RATIO >= top)
    .sort((a, b) => b.score - a.score || WORKSPACE_TRAITS.indexOf(a.trait) - WORKSPACE_TRAITS.indexOf(b.trait))
    .slice(0, TRAITS_MAX)
    .map((s) => s.trait)
}

/** One text's traits. Weight 1 needs two hits to clear the floor; a brief's weight trusts one. */
export function traitsOf(text: string, weight = 1): WorkspaceTrait[] {
  return rankTraits(scoreText(text, weight))
}

// ---- sources: weight per hit, and hits counted at most `cap` per trait ----

const BRIEF = { weight: 3, cap: 3 }
const PACKAGE_NAME = { weight: 2, cap: 1 }
const PACKAGE_ABOUT = { weight: 3, cap: 2 }
const DEPENDENCIES = { weight: 1, cap: 3 }
const README = { weight: 1, cap: 6 }

/** npm's own limit on a package name, and caps on what else of a manifest is read. */
const NAME_CHARS = 214
const ABOUT_CHARS = 1024
const KEYWORDS_MAX = 50
const DEPENDENCIES_MAX = 1000

const README_BYTES = 8 * 1024
/** A package.json past this is not a manifest worth parsing; truncated, it fails JSON and scores nothing. */
const PACKAGE_BYTES = 256 * 1024
const README_NAMES = ['README.md', 'readme.md']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const EMPTY: TraitScores = {}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const scoreWith = (text: string, source: { weight: number; cap: number }): TraitScores =>
  scoreText(text, source.weight, source.cap)

/** name, description, keywords and dependency NAMES; nothing else in the file is looked at. */
export function scorePackage(text: string): TraitScores {
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return EMPTY
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return EMPTY
  const fields = manifest as Record<string, unknown>
  const dependencies = DEPENDENCY_FIELDS.flatMap((field) => {
    const value = fields[field]
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : []
  })
  return addScores(
    scoreWith(textOf(fields.name).slice(0, NAME_CHARS), PACKAGE_NAME),
    scoreWith(textOf(fields.description).slice(0, ABOUT_CHARS), PACKAGE_ABOUT),
    scoreWith(stringsOf(fields.keywords).slice(0, KEYWORDS_MAX).join(' ').slice(0, ABOUT_CHARS), PACKAGE_ABOUT),
    scoreWith([...new Set(dependencies)].slice(0, DEPENDENCIES_MAX).join(' '), DEPENDENCIES)
  )
}

export const scoreReadme = (text: string): TraitScores => scoreWith(text, README)

// ---- the file reader ----

export interface TraitIo {
  /** A regular file's stamp; null when absent or not a file. May throw. */
  stat: (file: string) => { mtimeMs: number; size: number } | null
  /** At most `max` bytes, as UTF-8. May throw. */
  read: (file: string, max: number) => string
}

export const nodeTraitIo: TraitIo = {
  stat: (file) => {
    const stats = statSync(file, { throwIfNoEntry: false })
    return stats?.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : null
  },
  read: (file, max) => {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(max)
      const length = readSync(fd, buffer, 0, max, 0)
      return buffer.toString('utf8', 0, length)
    } finally {
      closeSync(fd)
    }
  }
}

/** Any error is "nothing here". */
function quietly<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** A file is stat'ed at most this often: a build every ~400 ms must not touch the disk (or a slow mount) each time. */
export const TRAIT_RECHECK_MS = 30_000
/** Files remembered; past this the oldest is forgotten (a removed workspace's files linger at most this long). */
const CACHE_FILES = 2048

interface Cached {
  /** When the file was last stat'ed. */
  checkedAt: number
  /** mtime:size, or null when the file was not there. */
  stamp: string | null
  scores: TraitScores | null
}

export type TraitLookup = (meta: Pick<WorkspaceMeta, 'brief' | 'dir' | 'dirs'>) => WorkspaceTrait[]

/**
 * The lookup the fleet build calls once per workspace per build. Each file is
 * stat'ed at most once per TRAIT_RECHECK_MS, and read and scored once per
 * path + mtime + size; a build in between touches nothing.
 */
export function createTraitLookup(io: TraitIo = nodeTraitIo, now: () => number = Date.now): TraitLookup {
  const cache = new Map<string, Cached>()

  const remember = (file: string, entry: Cached): void => {
    cache.delete(file)
    cache.set(file, entry)
    if (cache.size > CACHE_FILES) cache.delete(cache.keys().next().value as string)
  }

  /** The file's scores, or null when it is not there. */
  const scoresOf = (file: string, max: number, score: (text: string) => TraitScores): TraitScores | null => {
    const at = now()
    const hit = cache.get(file)
    if (hit && at - hit.checkedAt < TRAIT_RECHECK_MS) return hit.scores
    const stat = quietly<{ mtimeMs: number; size: number } | null>(() => io.stat(file), null)
    const stamp = stat === null ? null : `${stat.mtimeMs}:${stat.size}`
    if (hit && hit.stamp === stamp) {
      remember(file, { ...hit, checkedAt: at })
      return hit.scores
    }
    const text = stamp === null ? null : quietly<string | null>(() => io.read(file, max), null)
    const scores = stamp === null ? null : text === null ? EMPTY : quietly(() => score(text), EMPTY)
    remember(file, { checkedAt: at, stamp, scores })
    return scores
  }

  const projectScores = (dir: string): TraitScores => {
    const manifest = scoresOf(path.join(dir, 'package.json'), PACKAGE_BYTES, scorePackage) ?? EMPTY
    const readme = README_NAMES.reduce<TraitScores | null>(
      (found, name) => found ?? scoresOf(path.join(dir, name), README_BYTES, scoreReadme),
      null
    )
    return addScores(manifest, readme ?? EMPTY)
  }

  return (meta) => {
    const brief = typeof meta.brief === 'string' ? rankTraits(scoreWith(meta.brief, BRIEF)) : []
    if (brief.length > 0) return brief
    const dir = meta.dirs?.[0] ?? meta.dir
    if (typeof dir !== 'string' || dir.length === 0) return []
    return rankTraits(projectScores(dir))
  }
}
