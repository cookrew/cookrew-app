/**
 * A REPLY AS IT IS HEARD (prompt/reply-voice.ts, main/local-voice.ts).
 *
 * An agent's final message is drawn for the eye: fenced code, `**stars**`,
 * tables, links, absolute paths. Read aloud as written, a voice spells out
 * every backtick and every `/Users/…/src/main/` segment. This turns the
 * markdown into the sentences a person would say, then packs those sentences
 * into chunks a speech engine takes one at a time. The first chunk is short,
 * so the voice starts while the rest is still being made, and each chunk is
 * at most RAMP times the one before: the local voice makes audio about three
 * times faster than it plays, so chunk n is ready before chunk n-1 ends.
 */

/** The most of one reply that is read: a few minutes of speech, never an essay. */
export const SPEAK_MAX_CHARS = 1500

export interface ChunkSizes {
  /** The first chunk: short, so the first sound comes quickly. */
  readonly first?: number
  /** The largest chunk after it. */
  readonly rest?: number
  /** Each chunk at most this many times the one before (1 = no ramp). */
  readonly ramp?: number
}

const DEFAULT_FIRST = 36
const DEFAULT_REST = 240
const DEFAULT_RAMP = 2.5

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const CJK_STOPS = '\u3002\uff01\uff1f\uff1b\u2026'
const STOPS = `.!?;:,${CJK_STOPS}\uff1a\uff0c`
const GLYPHS = /[\u2500-\u259f\u23fa\u23bf\u25cf\u2022\u2713\u2714\u2717\u2718]/g
const PICTOGRAPHS = /\p{Extended_Pictographic}\ufe0f?/gu

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

interface Unit {
  readonly text: string
  /** A heading, list item or table row: it ends where its line ends. */
  readonly structural: boolean
}

/** The inline marks of one line, unwrapped into the words they carry. */
function inlineWords(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/(?:www\.)?([^/\s)?#:]+)[^\s)]*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}(?::\d+){0,2}/g, (path) => path.replace(/(?::\d+)+$/, '').split('/').pop() ?? '')
    .replace(/\b[\w.-]+(?:\/[\w.@+-]+){2,}(?::\d+){0,2}/g, (path) => path.replace(/(?::\d+)+$/, '').split('/').pop() ?? '')
    .replace(GLYPHS, '')
    .replace(PICTOGRAPHS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One markdown line, classified: null when nothing on it is read. */
function lineUnit(raw: string): Unit | null {
  const line = raw.trim()
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) return null
  if (/^\|.*\|$/.test(line)) {
    if (/^\|[\s:|-]+\|$/.test(line)) return null
    const cells = line.slice(1, -1).split('|').map(inlineWords).filter(Boolean)
    return cells.length > 0 ? { text: cells.join(', '), structural: true } : null
  }
  const heading = /^#{1,6}\s+/.test(line)
  const listed = /^(?:[-*+]|\d+[.)])\s+/.test(line)
  const text = inlineWords(line.replace(/^#{1,6}\s+/, '').replace(/^(?:>\s?)+/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, ''))
  return text ? { text, structural: heading || listed } : null
}

/** Lines into units: a structural line stands alone, plain lines join into their paragraph. */
function unitsOf(markdown: string): Unit[] {
  const units: Unit[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) units.push({ text: paragraph.join(' '), structural: false })
    paragraph = []
  }
  for (const raw of markdown.split('\n')) {
    if (raw.trim() === '') {
      flush()
      continue
    }
    const unit = lineUnit(raw)
    if (!unit) continue
    if (unit.structural) {
      flush()
      units.push(unit)
    } else {
      paragraph = [...paragraph, unit.text]
    }
  }
  flush()
  return units
}

function withStop(text: string): string {
  if (STOPS.includes(text.slice(-1))) return text
  return `${text}${hasCjk(text) ? '\u3002' : '.'}`
}

/** Index of the last sentence end in `text`, or -1. */
function lastSentenceEnd(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text[i]
    if (CJK_STOPS.includes(c) || c === '!' || c === '?') return i
    if (c === '.' && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i
  }
  return -1
}

/** The reply as sentences to say, at most `max` characters, ending at a sentence. */
export function speakableText(markdown: string, max: number = SPEAK_MAX_CHARS): string {
  const prose = (markdown || '').replace(/\r\n?/g, '\n').replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n')
  const units = unitsOf(prose)
  const text = units
    .map((unit, i) => (unit.structural || i < units.length - 1 ? withStop(unit.text) : unit.text))
    .join(' ')
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = lastSentenceEnd(cut)
  return (end > max / 2 ? cut.slice(0, end + 1) : cut).trim()
}

/** The text cut after each sentence end, never inside `voice.ts` or `3.5`. */
function sentencesOf(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const ends = CJK_STOPS.includes(c) || c === '!' || c === '?' || c === ';' || c === '\n' ||
      (c === '.' && (i + 1 === text.length || /\s/.test(text[i + 1])))
    if (!ends) continue
    const sentence = text.slice(start, i + 1).trim()
    if (sentence) out.push(sentence)
    start = i + 1
  }
  const tail = text.slice(start).trim()
  return tail ? [...out, tail] : out
}

/** A piece too long for `limit`, cut once: at its last comma, else its last space, else hard. */
function splitOnce(piece: string, limit: number): [string, string] {
  const window = piece.slice(0, limit)
  const comma = Math.max(...[',', '\uff0c', '\u3001', '\uff1a', ':'].map((mark) => window.lastIndexOf(mark)))
  if (comma > 0) return [piece.slice(0, comma + 1).trim(), piece.slice(comma + 1).trim()]
  const space = piece.slice(0, limit + 1).lastIndexOf(' ')
  if (space > limit / 3) return [piece.slice(0, space).trim(), piece.slice(space + 1).trim()]
  return [piece.slice(0, limit), piece.slice(limit)]
}

function joiner(left: string, right: string): string {
  return hasCjk(left.slice(-1)) || CJK_STOPS.includes(left.slice(-1)) ? (hasCjk(right.charAt(0)) ? '' : ' ') : ' '
}

/** Sentences packed into chunks: the first at most `first` long, growing by `ramp` up to `rest`. */
export function speechChunks(text: string, sizes: ChunkSizes = {}): string[] {
  const first = sizes.first ?? DEFAULT_FIRST
  const rest = sizes.rest ?? DEFAULT_REST
  const ramp = sizes.ramp ?? DEFAULT_RAMP
  const out: string[] = []
  let current = ''
  const limit = (): number => Math.min(rest, Math.round(first * ramp ** out.length))
  const add = (piece: string): void => {
    if (!piece) return
    const joined = current ? `${current}${joiner(current, piece)}${piece}` : piece
    if (joined.length <= limit()) {
      current = joined
      return
    }
    if (current) out.push(current)
    current = ''
    if (piece.length <= limit()) {
      current = piece
      return
    }
    const [head, tail] = splitOnce(piece, limit())
    out.push(head)
    add(tail)
  }
  for (const sentence of sentencesOf(text)) add(sentence)
  return current ? [...out, current] : out
}
