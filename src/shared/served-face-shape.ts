/**
 * THE FACE'S BOUNDS — shared by the serve sheet (renderer) and the IPC that
 * judges it (main, served-face.ts), so the sheet can refuse what main would
 * refuse while the button is still unpressed. The registry holds the same
 * numbers (registry/src/doors.ts).
 */
export const SUMMARY_MAX = 160
export const TAGS_MAX = 5
export const HARNESSES_MAX = 8

/** A tag: a slug, 1–24 characters. */
export const TAG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/
/** No control characters anywhere in a summary. */
export const PLAIN = /^[^\p{Cc}]*$/u

/** The comma-separated field, as a list. Blanks dropped; nothing else touched. */
export function parseTagInput(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

export function summaryLooksGood(summary: string): boolean {
  const trimmed = summary.trim()
  return trimmed.length <= SUMMARY_MAX && PLAIN.test(trimmed)
}

export function tagsLookGood(tags: readonly string[]): boolean {
  return tags.length <= TAGS_MAX && tags.every((tag) => TAG.test(tag)) && new Set(tags).size === tags.length
}
