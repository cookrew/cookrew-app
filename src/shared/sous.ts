// Sous — the local-model companion. Pure prompt/response helpers shared by
// the main-process Ollama client (src/main/sous.ts) and unit tests. The
// model's only job here is naming: compress a live turn (prompt + tool trail
// + output tail) into a short card title.

/** Hard cap for a card title; longer model output is cut with an ellipsis. */
export const TITLE_MAX_CHARS = 60

const PROMPT_SNIP = 300
const TAIL_SNIP = 1200
const MAX_TOOLS = 3

export interface TitleInput {
  /** The user prompt that started the turn. */
  prompt: string
  /** Recent tool invocations, oldest→newest. */
  tools: string[]
  /** Cleaned output lines of the turn so far. */
  lines: string[]
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text
}

/**
 * Build the instruction for the local model. Kept terse — small models
 * follow short imperative prompts far better than elaborate ones — and asks
 * for the title in the language of the user's prompt.
 */
export function buildTitlePrompt(input: TitleInput): string {
  const sections = [
    'You are watching a coding agent work inside a terminal.',
    'Summarize what the agent is doing RIGHT NOW as one short title, max 8 words.',
    'IMPORTANT: write the title in the SAME LANGUAGE as the user request below (Chinese request → Chinese title).',
    'Reply with the title only — no quotes, no punctuation, no explanation.',
    '',
    `User request: ${input.prompt.slice(0, PROMPT_SNIP)}`
  ]
  const tools = input.tools.slice(-MAX_TOOLS)
  if (tools.length > 0) {
    sections.push('', 'Recent tool calls:', ...tools.map((t) => `- ${t}`))
  }
  const tail = clip(input.lines.filter((l) => l.trim() !== '').join('\n'), TAIL_SNIP)
  if (tail !== '') {
    sections.push('', 'Recent output:', tail)
  }
  sections.push('', 'Title:')
  return sections.join('\n')
}

const THINK_BLOCK_RE = /<think>[\s\S]*?(?:<\/think>|$)/gi
const LABEL_PREFIX_RE = /^(?:title|标题)\s*[:：]\s*/i
const WRAPPING_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['《', '》']
]
const TRAILING_PUNCT_RE = /[\s.。，,;；:：!！?？…、-]+$/

/**
 * Reduce raw model output to a clean single-line title, or null when nothing
 * usable remains (empty output, pure punctuation, refusal-shaped noise).
 */
export function sanitizeTitle(raw: string): string | null {
  const noThink = raw.replace(THINK_BLOCK_RE, '')
  const firstLine = noThink
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!firstLine) return null

  let title = firstLine.replace(LABEL_PREFIX_RE, '').replace(/\*\*/g, '').trim()
  let unwrapped = true
  while (unwrapped && title.length >= 2) {
    unwrapped = false
    for (const [open, close] of WRAPPING_PAIRS) {
      if (title.startsWith(open) && title.endsWith(close)) {
        title = title.slice(open.length, title.length - close.length).trim()
        unwrapped = true
      }
    }
  }
  title = title.replace(TRAILING_PUNCT_RE, '').trim()
  if (title === '') return null
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title
}
