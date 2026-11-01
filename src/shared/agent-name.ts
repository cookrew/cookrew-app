/**
 * A NEW AGENT'S NAME, FROM ITS FIRST PROMPT (owner, 2026-11-01). herdr names
 * nothing itself (it only relays a program's own terminal title, and Claude
 * Code's is switched off on this machine), so the name is read off the words.
 *
 * Two readings, the way Claude Code's /rename titles a chat:
 *
 *   nameFromPrompt   at once, by rule: an English prompt by its subject, its
 *                    leading verb and filler dropped; a Chinese one by its
 *                    first few characters, its polite lead-in dropped. It is
 *                    a stand-in, and it truncates.
 *   Sous             a moment later, by a model (main/agent-namer.ts): a
 *                    short noun phrase for what the task is about. Its answer
 *                    passes sanitizeAgentName or is dropped, and the stand-in
 *                    stays.
 *
 * The store makes either unique in the workspace.
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

/** The longest name a card wears, whoever chose it. */
export const AGENT_NAME_MAX = 40

/**
 * A name someone CHOSE (`cookrew rename`, `recruit "Name"`), made safe to wear:
 * one line, no control characters, single spaces, at most AGENT_NAME_MAX.
 * Empty means there was no name in it.
 */
export function cleanAgentName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return Array.from(flat).slice(0, AGENT_NAME_MAX).join('').trim()
}

/**
 * What Sous is told. Examples beat rules on a 3b model: without them it
 * answered "PromptAgent", or a phrase that was not the task, for two of
 * five tasks; a 1.5b one turned every Chinese task into an English name
 * (measured, 2026-11-01).
 */
/** The examples Sous is shown; an answer that is one of them is an echo, not a name. */
const NAME_EXAMPLES: readonly (readonly [string, string])[] = [
  ['fix the 500 error on the billing webhook', 'Billing Webhook'],
  ['write e2e tests for the signup flow and run them', 'Signup E2E Tests'],
  ['帮我把设置页的深色模式做完', '设置页深色模式'],
  ['看看为什么手机上键盘会遮住输入框', '手机键盘遮挡']
]

export function buildNameSystem(): string {
  return [
    'You name a coding agent after the task it is given, the way a person titles a chat.',
    'The name is a short noun phrase for the SUBJECT of the task: 2 to 4 words, or 2 to 8 characters in Chinese.',
    'Write it in the same language as the task (a Chinese task gets a Chinese name).',
    'No verbs like fix/add/implement, no quotes, no punctuation, no explanation.',
    'Reply with the name only.',
    '',
    'Examples:',
    ...NAME_EXAMPLES.map(([task, name]) => `Task: ${task} -> ${name}`)
  ].join('\n')
}

/** Enough of the task to name it; the rest is detail a title never carries. */
const NAME_TASK_SNIP = 1200

export function buildNamePrompt(prompt: string): string {
  return `Task:\n${prompt.trim().slice(0, NAME_TASK_SNIP)}\n\nName:`
}

const THINK_RE = /<think>[\s\S]*?(?:<\/think>|$)/giu
const LABEL_RE = /^(?:name|agent name|title|名字|名称)\s*[:：]\s*/iu
const ARROW_RE = /^.*?(?:->|→)\s*/u
const WRAP_RE = /^["'“”‘’「」『』《》`*]+|["'“”‘’「」『』《》`*]+$/gu
const TRAILING_RE = /[\s.,;:!?。，；：！？、]+$/u
const HAN_RE = /\p{Script=Han}/u
const HAN_ALL_RE = /\p{Script=Han}/gu

/** A Chinese task is one written mostly in Han. */
const mostlyHan = (text: string): boolean => {
  const han = text.match(HAN_ALL_RE)?.length ?? 0
  const latin = text.match(/[A-Za-z]+/gu)?.length ?? 0
  return han > 0 && han >= latin
}

/**
 * Reduce Sous's answer to a name, or null when it is not one: empty, a
 * sentence, an echo of the examples, or a Chinese task named in English (the
 * small model's habit). A null keeps the stand-in, which is never worse than
 * a wrong name.
 */
export function sanitizeAgentName(raw: string, prompt: string): string | null {
  const line = raw
    .replace(THINK_RE, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!line) return null
  // "Task: … -> Name" is an example's shape: the name is what follows the
  // arrow, and a bare "Task: …" with none is the model reading the prompt back.
  const named = line.replace(LABEL_RE, '').replace(ARROW_RE, '')
  if (/^task\s*[:：]/iu.test(named)) return null
  const name = cleanAgentName(named.replace(TRAILING_RE, '').replace(WRAP_RE, '').replace(TRAILING_RE, ''))
  if (name === '' || !/[\p{L}\p{N}]/u.test(name)) return null
  if (Array.from(name).length > 32) return null
  if (HAN_RE.test(name) ? (name.match(HAN_ALL_RE)?.length ?? 0) > 12 : name.split(' ').length > 5) return null
  if (mostlyHan(prompt) && !HAN_RE.test(name)) return null
  if (NAME_EXAMPLES.some(([, example]) => example.toLowerCase() === name.toLowerCase())) return null
  return name
}
