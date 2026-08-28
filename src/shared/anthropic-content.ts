// Reading an Anthropic-style /v1/messages response.
//
// Small on purpose and pure on purpose: the one thing here that can go wrong is
// silent, so it is worth being able to test without a network.

/** One block of a message's content. Unknown `type`s are expected, not errors. */
export interface ContentBlock {
  type?: string
  text?: string
}

export interface MessagesResponse {
  content?: ContentBlock[]
}

/**
 * THE ANSWER IS THE `text` BLOCKS AND ONLY THE `text` BLOCKS.
 *
 * A reasoning model answers with a `thinking` block FIRST and the reply after
 * it. Joining the whole content array — the obvious implementation — puts the
 * model's private deliberation ("We need to translate into Japanese. Keep the
 * backticks unchanged...") at the top of the body, in English, where the reader
 * has every reason to believe it is part of the transcript.
 *
 * So this filters by type rather than skipping the first block: `thinking` is
 * not the only non-answer block that exists, and position is not what makes a
 * block the answer.
 */
export function textFromContent(response: MessagesResponse | null | undefined): string {
  const blocks = response?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}
