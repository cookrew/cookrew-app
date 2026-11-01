/**
 * A NEW AGENT'S NAME, FROM ITS FIRST PROMPT (owner, 2026-11-01). herdr names
 * nothing itself (it only relays a program's own terminal title, and Claude
 * Code's is switched off on this machine), so the name is read off the words:
 * an English prompt by its subject, its leading verb and filler dropped; a
 * Chinese one by its first few characters, its polite lead-in dropped. The
 * store makes it unique in the workspace.
 */

const MAX = 20
const HAN_MAX = 6

const STOP = new Set([
  'a', 'an', 'the', 'to', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'about',
  'please', 'pls', 'can', 'could', 'would', 'will', 'you', 'your', 'i', 'me', 'my', 'we', 'us', 'our', 'it', 'its',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'be', 'do', 'does', 'why', 'what', 'how', 'when', 'where',
  'which', 'who', 'some', 'all', 'any', 'just', 'now', 'then', 'so', 'up', 'out', 'let', 'lets', 'help'
])

/** Leading verbs say what to do, not what it is about: dropped when a subject follows. */
const VERBS = new Set([
  'fix', 'add', 'make', 'write', 'build', 'update', 'check', 'look', 'find', 'run', 'create', 'implement',
  'refactor', 'investigate', 'debug', 'review', 'test', 'deploy', 'design', 'research', 'explain', 'improve',
  'clean', 'remove', 'delete', 'change', 'move', 'rename', 'set', 'get', 'show', 'read', 'draft', 'plan'
])

const HAN_LEAD = /^(?:请|帮我|帮忙|麻烦|你|给我|我想|我要|可以|能不能|能否)+/u

const title = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

function hanName(text: string): string {
  const run = text.replace(HAN_LEAD, '').match(/\p{Script=Han}+/u)?.[0] ?? ''
  return run.slice(0, HAN_MAX)
}

function wordName(text: string): string {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w))
  const subject = words.length > 1 && VERBS.has(words[0]) ? words.slice(1) : words
  let name = ''
  for (const word of subject.slice(0, 2)) {
    const next = name ? `${name} ${title(word)}` : title(word)
    if (next.length > MAX) break
    name = next
  }
  return name || (subject[0] ? title(subject[0]).slice(0, MAX) : '')
}

export function nameFromPrompt(prompt: string): string {
  const text = prompt.replace(/^\s*@\S+\s*/u, '').trim()
  const first = text.match(/\p{L}/u)?.[0]
  if (!first) return 'Agent'
  const name = /\p{Script=Han}/u.test(first) ? hanName(text) : wordName(text)
  return name || 'Agent'
}
