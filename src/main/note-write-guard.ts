/**
 * THE GUARD IN FRONT OF `cookrew note write`.
 *
 * A write replaces the whole note, and a note is named from its first line,
 * so a write with nothing to write is not harmless: `note write "Name" --file
 * /tmp/x.txt` reached the app as the name plus a `file` flag, wrote '' over a
 * 107-line note, answered OK, and the note became "untitled (2)" and dropped
 * out of `cookrew list` (2026-08-20).
 *
 * The CLI client (cli/cookrew.mjs parseArgv) puts every `--key [value]` in
 * request.flags and every other token in request.args, so a mistake arrives
 * in one of two shapes: an unknown flag, or a flag-looking token (`-f`) left
 * in the args as the content. Both are refused before anything is touched.
 * An explicit "" is a deliberate clear and still writes.
 */

export const NOTE_WRITE_USAGE =
  'Usage: cookrew note write "Name" "content"  (one quoted content argument; "" clears the note; ' +
  'for a file\'s contents pass "$(cat FILE)")'

/** Flags `note write` consumes: `--as` names the caller from a plain shell. */
const NOTE_WRITE_FLAGS: ReadonlySet<string> = new Set(['as'])

/** A whole argument that is one flag word: `-f`, `--file`. Not `- item`, not `---`. */
const FLAG_TOKEN = /^--?[A-Za-z][\w-]*$/

function refuse(why: string): Error {
  return new Error(`${why} Nothing was written.\n${NOTE_WRITE_USAGE}`)
}

export interface NoteWrite {
  readonly name: string
  readonly content: string
}

/**
 * The note name and content of a `note write`, or a usage error when the
 * request does not carry exactly one content argument and no stray flag.
 * `rest` is request.args after the `write` subcommand.
 */
export function parseNoteWrite(rest: readonly string[], flags: Readonly<Record<string, unknown>>): NoteWrite {
  const unknown = Object.keys(flags).filter((key) => !NOTE_WRITE_FLAGS.has(key))
  if (unknown.length > 0) {
    const named = unknown.map((key) => `--${key}`).join(', ')
    throw refuse(`note write takes no ${named} (unknown flag${unknown.length > 1 ? 's' : ''}).`)
  }
  const [name, content, ...extra] = rest
  if (name === undefined || name === '') throw refuse('Missing note name.')
  if (content === undefined) throw refuse(`Missing content for note '${name}'.`)
  if (extra.length > 0) {
    throw refuse(
      `note write takes one content argument, got ${extra.length + 1} — quote the content.`
    )
  }
  if (FLAG_TOKEN.test(content)) {
    throw refuse(`The content '${content}' looks like a flag, not note text.`)
  }
  return { name, content }
}

/** The reply to a write that landed: a plain OK, or the rename it caused. */
export function noteWriteReply(before: string, after: string): string {
  if (before === after) return 'OK'
  return `OK — note renamed "${before}" -> "${after}" (a note is named from its first line)`
}
