/**
 * Tiny markdown parser for trace reply blocks (unified-scroll addendum). Agent
 * replies arrive as markdown; raw asterisks/backticks read as noise, so we parse
 * a SMALL, safe subset — bold, italics, inline code, fenced code, headings,
 * lists — into a typed AST. A .tsx renderer (MarkdownText) walks this into React
 * elements only: no dangerouslySetInnerHTML, no raw HTML pass-through. Anything
 * unrecognized degrades to plain text. Kept as a pure, JSX-free module so the
 * grammar is unit-tested directly (the AST is the contract).
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'code'; value: string }

export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const FENCE_OPEN_RE = /^```(.*)$/
const FENCE_CLOSE_RE = /^```\s*$/

/** True when `char` is a word character (guards underscores inside snake_case). */
function isWord(char: string | undefined): boolean {
  return char !== undefined && /\w/.test(char)
}

/**
 * The index of the single-delimiter emphasis close for `delim` opened just
 * before `from`, or -1. Skips a doubled delimiter (that belongs to strong) and,
 * for `_`, a close wedged inside a word (snake_case). Pure — unit-tested.
 */
function findEmphasisClose(src: string, from: number, delim: string): number {
  for (let k = from; k < src.length; k++) {
    if (src[k] !== delim) continue
    if (src[k + 1] === delim || src[k - 1] === delim) continue
    if (delim === '_' && isWord(src[k + 1])) continue
    return k
  }
  return -1
}

/**
 * Parse inline markdown into nodes. Precedence: inline code (backticks protect
 * their content from further parsing), then strong (`**`/`__`), then emphasis
 * (`*`/`_`). An unmatched or intra-word delimiter is literal text. Pure —
 * unit-tested.
 */
export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = []
  let text = ''
  let i = 0
  const flush = (): void => {
    if (text) {
      out.push({ type: 'text', value: text })
      text = ''
    }
  }
  while (i < src.length) {
    const c = src[i]
    // inline code — literal, no nested formatting
    if (c === '`') {
      const j = src.indexOf('`', i + 1)
      if (j > i) {
        flush()
        out.push({ type: 'code', value: src.slice(i + 1, j) })
        i = j + 1
        continue
      }
    }
    // strong **…** / __…__
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const delim = c + c
      const j = src.indexOf(delim, i + 2)
      if (j > i + 1) {
        flush()
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, j)) })
        i = j + 2
        continue
      }
    }
    // emphasis *…* / _…_ (underscore only outside a word)
    if (c === '*' || c === '_') {
      const intraWord = c === '_' && isWord(src[i - 1])
      if (!intraWord) {
        const j = findEmphasisClose(src, i + 1, c)
        if (j > i) {
          flush()
          out.push({ type: 'em', children: parseInline(src.slice(i + 1, j)) })
          i = j + 1
          continue
        }
      }
    }
    text += c
    i++
  }
  flush()
  return out
}

/**
 * Parse a markdown document (a reply body) into block nodes. Line-based: fenced
 * code, ATX headings, ordered/unordered lists, blank-line-delimited paragraphs.
 * Unsupported constructs fall through to paragraph text. Pure — unit-tested.
 */
export function parseMarkdown(src: string): BlockNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: BlockNode[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) {
      blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) })
      para = []
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // fenced code — everything up to the closing fence is literal
    const fence = FENCE_OPEN_RE.exec(line)
    if (fence) {
      flushPara()
      const lang = fence[1].trim() || null
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // step over the closing fence (or past EOF)
      blocks.push({ type: 'code', lang, value: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushPara()
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) })
      i++
      continue
    }

    // list — accumulate consecutive same-kind items into one list
    const first = LIST_RE.exec(line)
    if (first) {
      flushPara()
      const ordered = /\d/.test(first[2])
      const items: InlineNode[][] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i])
        if (!m || /\d/.test(m[2]) !== ordered) break
        items.push(parseInline(m[3]))
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }
  flushPara()
  return blocks
}
