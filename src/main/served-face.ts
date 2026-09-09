import type { TeamSnapshot } from './teams'
import { HARNESSES_MAX, PLAIN, SUMMARY_MAX, TAG, TAGS_MAX } from '../shared/served-face-shape'

/**
 * THE FACE'S WORDS — what an owner may say about a served team, and the
 * harness names derived from it. Both go verbatim to the registry (see
 * registry/src/doors.ts, which holds the same bounds), so the app refuses
 * here what the registry would refuse there: an owner learns at the sheet,
 * not from a listing that silently never appeared.
 *
 * REFUSED, NEVER TRIMMED. A summary cut at 160 is a sentence the owner did
 * not write; a sixth tag dropped is a choice made for them. Either is the
 * quiet-consequence bug this product refuses everywhere else.
 */

export { HARNESSES_MAX, SUMMARY_MAX, TAG, TAGS_MAX } from '../shared/served-face-shape'

export interface FaceWords {
  summary?: string
  tags?: readonly string[]
}

export type FaceWordsRefusal = 'bad-summary' | 'bad-tags'

/**
 * Validate the owner's words. Absent, blank and empty all mean ABSENT — the
 * sheet's inputs start empty, and an empty summary is not a summary.
 */
export function faceWords(input: {
  summary?: unknown
  tags?: unknown
}): { ok: true; words: FaceWords } | { ok: false; reason: FaceWordsRefusal } {
  const summary = summaryOf(input.summary)
  if (summary === false) return { ok: false, reason: 'bad-summary' }
  const tags = tagsOf(input.tags)
  if (tags === false) return { ok: false, reason: 'bad-tags' }
  return {
    ok: true,
    words: {
      ...(summary === null ? {} : { summary }),
      ...(tags === null ? {} : { tags })
    }
  }
}

/** The summary, null when absent, false when refused. */
function summaryOf(value: unknown): string | null | false {
  if (value === undefined) return null
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > SUMMARY_MAX || !PLAIN.test(trimmed)) return false
  return trimmed
}

/** The tags, null when absent, false when refused. */
function tagsOf(value: unknown): readonly string[] | null | false {
  if (value === undefined) return null
  if (!Array.isArray(value)) return false
  if (value.length === 0) return null
  if (value.length > TAGS_MAX) return false
  if (!value.every((tag): tag is string => typeof tag === 'string' && TAG.test(tag))) return false
  if (new Set(value).size !== value.length) return false
  return [...value]
}

/**
 * The HARNESS NAMES behind a door: each terminal's preset, distinct, in
 * roster order. Names of products, never names of agents — the roster is the
 * owner's business. The empty preset is a bare shell and says nothing; a
 * 'Remote' card is someone else's team mirrored here, and its harness is
 * theirs to declare.
 */
export function harnessesOf(snapshot: TeamSnapshot): readonly string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const node of snapshot.nodes) {
    if (node.kind !== 'terminal') continue
    const preset = node.preset
    if (preset.length === 0 || preset === 'Remote' || seen.has(preset)) continue
    seen.add(preset)
    names.push(preset)
  }
  return names.slice(0, HARNESSES_MAX)
}
