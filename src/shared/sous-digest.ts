// THE CANVAS DIGEST (HP round, lane hp-decide) — the board as ONE positional
// table a decider can read in a single pass: one line per card, numbered, so a
// later scorer can answer with a position and nothing else. Pure, bounded:
// the budget is tokens, not cards, and the table stops with a footer that
// says how many it left out. No pane captures, no model — what the Board
// already knows.
//
// Tokens are APPROXIMATED here (chars / 3.2 for Latin, 1 per CJK character):
// gpt-tokenizer is not a dependency of this repo and the HP brief allows the
// approximation when adding one is a problem. The test fixture is 200 cards.

export interface DigestCard {
  id: string
  name: string
  /** The harness or preset name ("Claude Code", "Codex", "Pi"), when known. */
  harness: string | null
  role: string | null
  orch: boolean
  phase: string
  cwd: string
  lastTask: string | null
  lastActivityAt: number
  served?: boolean
  contextFull?: boolean
}

export interface DigestOptions {
  workdir: string | null
  now: number
  /** The budget the whole text must stay under. */
  maxTokens?: number
  /** Longest last-task cell. */
  taskChars?: number
}

export interface Digest {
  text: string
  tokens: number
  /** Cards listed, in table order (the position is 1-based in the text). */
  listed: DigestCard[]
  omitted: number
}

export const DIGEST_MAX_TOKENS = 2500

/** chars / 3.2 for Latin text, one per CJK character — a deliberate overestimate on the Latin side. */
export function approxTokens(text: string): number {
  let cjk = 0
  for (const ch of text) if (ch >= '一' && ch <= '鿿') cjk += 1
  return Math.ceil((text.length - cjk) / 3.2) + cjk
}

const IDLE = new Set(['done', 'unread', 'waiting', 'idle', 'replied'])

function ago(at: number, now: number): string {
  if (at <= 0) return '—'
  const m = Math.max(0, Math.round((now - at) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

const cell = (text: string | null, max: number): string => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || '—'
}

/** Same-repo idle first (the cards a brief can go to), then same-repo busy, then the rest; newest activity first inside each band. */
export function digestOrder(cards: readonly DigestCard[], workdir: string | null): DigestCard[] {
  const band = (c: DigestCard): number => {
    const here = workdir !== null && c.cwd === workdir
    if (c.served) return 4
    if (here && IDLE.has(c.phase) && !c.contextFull) return 0
    if (here) return 1
    if (IDLE.has(c.phase)) return 2
    return 3
  }
  return [...cards].sort((a, b) => band(a) - band(b) || b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name))
}

export function buildDigest(cards: readonly DigestCard[], options: DigestOptions): Digest {
  const max = options.maxTokens ?? DIGEST_MAX_TOKENS
  const taskChars = options.taskChars ?? 40
  const ordered = digestOrder(cards, options.workdir)
  const header = `workdir: ${options.workdir ?? '—'} · cards: ${cards.length}\n# | card | harness | role | phase | ago | repo | last task`
  const footerFor = (omitted: number): string => (omitted > 0 ? `\n+${omitted} more cards not listed` : '')
  const lines: string[] = []
  const listed: DigestCard[] = []
  let used = approxTokens(header)
  for (const c of ordered) {
    const repo = options.workdir !== null && c.cwd === options.workdir ? 'here' : cell(c.cwd.split('/').filter(Boolean).at(-1) ?? c.cwd, 16)
    const line = `${listed.length + 1} | ${cell(c.name, 18)}${c.orch ? ' (orch)' : ''}${c.served ? ' (seat)' : ''} | ${cell(c.harness, 11)} | ${cell(c.role, 14)} | ${c.phase}${c.contextFull ? ' full' : ''} | ${ago(c.lastActivityAt, options.now)} | ${repo} | ${cell(c.lastTask, taskChars)}`
    const cost = approxTokens(line) + 1
    // Leave room for the footer that will say how many were left out.
    if (used + cost + 8 > max) break
    used += cost
    lines.push(line)
    listed.push(c)
  }
  const omitted = cards.length - listed.length
  const text = `${header}\n${lines.join('\n')}${footerFor(omitted)}`
  return { text, tokens: approxTokens(text), listed, omitted }
}
