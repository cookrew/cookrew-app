/**
 * WHAT AN AGENT HAS TYPED, UNSENT (owner, 2026-11-01): the crew says it under
 * the agent's face. Its draft first (prompt/prompt-draft.ts: the prompt box
 * carrying @agent and its card's reply box), as it is the newest; else what
 * the tracker reads sitting in the agent's own input line (words typed in
 * LIVE or on another device, TurnViewModel.pendingInput). One line: the
 * first, trimmed, without the "@Name" that only addressed the prompt box.
 * A draft that names another agent, or a name still being typed, is not this
 * agent's: none of it goes into its line (live-line.ts · lineTextFor).
 */
export function typingOf(draft: string, pending: string | null | undefined, name: string): string | null {
  const own = firstLine(withoutMention(draft, name))
  if (own) return own
  return firstLine(pending ?? '') || null
}

const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').trim()

function withoutMention(text: string, name: string): string {
  const lead = text.trimStart()
  if (!lead.startsWith('@')) return text
  const mention = `@${name}`
  const rest = lead.slice(mention.length)
  const own = lead.slice(0, mention.length).toLowerCase() === mention.toLowerCase() && (rest === '' || /^\s/u.test(rest))
  return own ? rest : ''
}
