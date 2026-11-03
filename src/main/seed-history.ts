/**
 * THE PANE'S HISTORY, MADE FIT TO READ (PtySession.seedFrame).
 *
 * herdr keeps everything the pane ever showed, and two things in it read as
 * garbage on a phone (owner's screenshot, 2026-10-31: one answer three times,
 * its table at three widths, single characters on lines of their own):
 *
 *   REPRINTS. Every resize of the shared pane — a phone opening it at 49
 *   columns, the desktop taking it back — makes Claude Code print its recent
 *   conversation again at the new width, and herdr keeps the old copy too
 *   (reflowed to the new width). dropReprints keeps the LATER copy and drops
 *   the earlier one, matching on the text with spaces and box lines removed,
 *   so the same words at another width still match.
 *
 *   THE SEAM. The history is read off-thread (~0.5 s) and the screen is
 *   serialized when it lands; output in between makes "the last screenful of
 *   the history" not the screen. cutAtScreen finds where the screen begins in
 *   the history by its text and cuts there.
 *
 * Pure, on plain arrays of ANSI lines, so it is tested as data.
 */

/** Escape sequences out: CSI, OSC, and the two-byte ones. */
export const stripAnsi = (line: string): string =>
  line.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')

/** The words only: no spaces, no box drawing, no variation selectors — width-independent. */
export const textKey = (line: string): string =>
  stripAnsi(line).replace(/[\s ─-╿︎️]/g, '')

/** A repeat must run this long (in key characters) to count as a reprint, not a phrase said twice. */
export const REPRINT_MIN = 100
const GRAM = 32

/**
 * Drop each run of history that is printed again later. `lines` may be
 * removed from; `trailing` (the screen) takes part in the matching but is
 * never removed — a reprint whose later copy is on screen still drops its
 * earlier one.
 */
export function dropReprints(lines: readonly string[], trailing: readonly string[] = [], min = REPRINT_MIN): string[] {
  const keys = [...lines, ...trailing].map(textKey)
  const start: number[] = []
  let text = ''
  for (const key of keys) {
    start.push(text.length)
    text += key
  }
  const drop = new Array<boolean>(lines.length).fill(false)
  // The most recent occurrence of every gram ending before the line being
  // looked at: a third copy matches the second, which then goes too.
  const seen = new Map<string, number>()
  let added = 0
  const addUpTo = (end: number): void => {
    for (; added + GRAM <= end; added++) seen.set(text.slice(added, added + GRAM), added)
  }
  let i = 0
  while (i < keys.length) {
    const pos = start[i]
    if (keys[i].length === 0 || pos + GRAM > text.length) {
      i++
      continue
    }
    addUpTo(pos)
    const at = seen.get(text.slice(pos, pos + GRAM))
    if (at === undefined) {
      i++
      continue
    }
    let m = 0
    while (pos + m < text.length && at + m < pos && text[at + m] === text[pos + m]) m++
    if (m < min) {
      i++
      continue
    }
    // Lines wholly inside the earlier copy go (blank lines in it too).
    for (let j = 0; j < lines.length; j++) {
      if (start[j] >= at && start[j] + keys[j].length <= at + m) drop[j] = true
    }
    // Past this copy; the grams in it stay known for the next one.
    while (i < keys.length && start[i] < pos + m) i++
  }
  return lines.filter((_, j) => !drop[j])
}

/**
 * The history above the screen: everything before the screen's first words,
 * found from the end. When they cannot be found (a blank screen, or output
 * the history has not caught up with), the last screenful is dropped, as
 * before.
 */
export function cutAtScreen(lines: readonly string[], screen: readonly string[], rows: number): string[] {
  const probe = screen.map(textKey).join('').slice(0, 60)
  const fallback = lines.slice(0, Math.max(0, lines.length - rows))
  if (probe.length < 12) return fallback
  const keys = lines.map(textKey)
  const start: number[] = []
  let text = ''
  for (const key of keys) {
    start.push(text.length)
    text += key
  }
  const at = text.lastIndexOf(probe)
  if (at < 0) return fallback
  // The line the screen's first words fall in, and everything after it, is the screen.
  let cut = 0
  while (cut + 1 < keys.length && start[cut + 1] <= at) cut++
  // Only near the end: a match far up is an older copy of the same words.
  if (lines.length - cut > rows * 2 + 50) return fallback
  return lines.slice(0, cut)
}

/** Cells a character takes, as xterm's default (Unicode 6) widths count them: wide CJK 2, marks 0. */
export function cellWidth(code: number): number {
  if (code === 0 || (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200b || code === 0x200d) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

/**
 * An ANSI line cut to `cols` cells, its escapes kept — but ONLY when what
 * hangs past the edge is spaces or box lines (a border or padding printed at
 * a wider width): that is cut instead of wrapping onto a line of its own.
 * When real text hangs past the edge the line is returned whole and wraps,
 * because cutting it loses words (measured: a paragraph printed at 198
 * columns lost two thirds of itself at 49).
 */
export function clipToCells(line: string, cols: number): string {
  let out = ''
  let over = ''
  let used = 0
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const esc = /^\x1b\[[0-?]*[ -/]*[@-~]|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b[@-_]/.exec(line.slice(i))
      const seq = esc ? esc[0] : line[i]
      out += seq
      i += seq.length
      continue
    }
    const code = line.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(code)
    const w = cellWidth(code)
    if (used + w > cols) {
      // Past the edge: escapes are kept (colour resets), the text is weighed.
      over += ch
      i += ch.length
      continue
    }
    out += ch
    used += w
    i += ch.length
  }
  return /^[\s ─-╿]*$/.test(over) ? out : line
}

/**
 * WHOLE MESSAGES, KEPT ONCE (owner's recording, 2026-10-31: scrolling LIVE
 * back showed the same answer four times).
 *
 * dropReprints matches long runs of identical text, and a reprint is not
 * always identical: when Claude Code redraws at another width, rows it did not
 * repaint keep cells from the old screen (measured on a live pane: a copy of a
 * reply with a row of an earlier diff in the middle of it). The run breaks at
 * that row and every older copy survived.
 *
 * What does survive a redraw intact is the HEAD of each message: `⏺` a reply
 * or a tool call, `❯` a prompt, `✻ … · done 2:05 PM` the end of a turn. So the
 * history is cut into messages at their heads and read from the newest end;
 * a message whose head appears again later is an older copy and goes, with
 * its body, garbage and all. Heads match on their first words (sameHead), so
 * a head narrow-wrapped at another width, or with old cells past its end,
 * still matches.
 *
 * Heads that legitimately repeat — a tool call run twice, a prompt like
 * "merge" — are WEAK: they never drop anything by themselves, and go only
 * inside a copy, when the strong head they follow (a reply, a prompt, a done
 * line) went too.
 */
const HEAD = /^\s{0,1}([⏺●❯]|[✻✳✢✶✽*]\s.*·\s*done\s+\d)/
const TOOL_HEAD = /^[⏺●]\s*[A-Z][\w-]*\(/
/** Key characters a head needs to identify a message on its own. */
export const STRONG_HEAD_MIN = 12

const headOf = (line: string): string | null => {
  const text = stripAnsi(line)
  return HEAD.test(text) ? text : null
}

/**
 * Two heads are one message when they agree as far as both go, up to this
 * many key characters: a copy can be narrow-wrapped shorter, or carry an old
 * row's cells past its end, and still be the same message.
 */
export const HEAD_MATCH = 48
const sameHead = (a: string, b: string): boolean => {
  const n = Math.min(a.length, b.length, HEAD_MATCH)
  return n >= STRONG_HEAD_MIN && a.slice(0, n) === b.slice(0, n)
}

export function dropReprintedMessages(lines: readonly string[], trailing: readonly string[] = []): string[] {
  // Each message: its first line, its head's key, and whether that key can identify it alone.
  const starts: { at: number; key: string; strong: boolean }[] = []
  lines.forEach((line, at) => {
    const head = headOf(line)
    if (head === null) return
    const key = textKey(head)
    starts.push({ at, key, strong: key.length >= STRONG_HEAD_MIN && !TOOL_HEAD.test(head.trimStart()) })
  })
  if (starts.length === 0) return [...lines]
  // The screen holds the newest copy of what it shows.
  const seen: string[] = trailing.flatMap((line) => {
    const head = headOf(line)
    const key = head === null ? '' : textKey(head)
    return key.length >= STRONG_HEAD_MIN ? [key] : []
  })
  const dropMessage = new Array<boolean>(starts.length).fill(false)
  for (let m = starts.length - 1; m >= 0; m--) {
    const { key, strong } = starts[m]
    if (!strong) continue
    if (seen.some((later) => sameHead(key, later))) dropMessage[m] = true
    else seen.push(key)
  }
  // A weak message goes with the strong one it follows.
  let lastStrongDropped = false
  for (let m = 0; m < starts.length; m++) {
    if (starts[m].strong) lastStrongDropped = dropMessage[m]
    else dropMessage[m] = lastStrongDropped
  }
  const drop = new Array<boolean>(lines.length).fill(false)
  starts.forEach((start, m) => {
    if (!dropMessage[m]) return
    const end = m + 1 < starts.length ? starts[m + 1].at : lines.length
    for (let j = start.at; j < end; j++) drop[j] = true
  })
  return lines.filter((_, j) => !drop[j])
}
