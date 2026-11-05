/**
 * WHAT ENTER (OR SEND) DOES WITH THE BOX'S WORDS (GlobalPrompt.tsx · submit).
 *
 *   "@Other the rest"  goes to Other, whoever the box carries; "@Other" alone is nothing.
 *   an agent           the words go to its input line; an empty box is nothing,
 *                      except in that agent's own full view, where a bare Enter
 *                      goes to the terminal in sight (as today: from a card it
 *                      could answer a permission prompt nobody is looking at).
 *   nobody             the words make a new agent; no words make nothing.
 *
 * `none` is also what keeps Enter in an empty box from sending: the input
 * swallows it, and Send is disabled.
 */

export type SendPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'mention'; readonly id: string; readonly words: string }
  | { readonly kind: 'agent'; readonly id: string; readonly words: string }
  | { readonly kind: 'new'; readonly words: string }

const NONE: SendPlan = { kind: 'none' }

export function sendPlan({
  text,
  to,
  fullAgentId,
  mention
}: {
  text: string
  to: { readonly id: string } | null
  fullAgentId: string | null
  /** "@Name the rest", read off the words (prompt-target.ts · mentionTarget). */
  mention: { readonly id: string; readonly text: string } | null
}): SendPlan {
  if (mention && mention.id !== to?.id) return mention.text ? { kind: 'mention', id: mention.id, words: mention.text } : NONE
  if (to) {
    const words = mention ? mention.text : text
    if (words.trim()) return { kind: 'agent', id: to.id, words }
    return to.id === fullAgentId ? { kind: 'agent', id: to.id, words: '' } : NONE
  }
  const prompt = text.trim()
  return prompt ? { kind: 'new', words: prompt } : NONE
}
