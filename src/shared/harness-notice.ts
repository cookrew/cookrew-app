/**
 * A turn the HARNESS started, not the owner.
 *
 * When a background task an agent launched finishes, Claude Code wakes the
 * agent with a user-role message of its own making:
 *
 *     <task-notification>
 *     <task-id>…</task-id>
 *     <tool-use-id>…</tool-use-id>
 *     <output-file>…</output-file>
 *     <status>completed</status>
 *     <summary>Agent "Review socket leak fix diff" finished</summary>
 *     </task-notification>
 *
 * It is a real turn — the agent answers it, and Claude counts it as one
 * (turnIndex moves, promptIndex does not; the entry says origin.kind
 * "task-notification", promptSource "system"). So it keeps its checkpoint and
 * its identity: nothing here touches the ordinal, the uuid or the stored
 * promptHead, which the stream's replay verdict compares.
 *
 * What it must not do is read as the owner speaking (phone report
 * 2026-11-01): the card said "You: <task-notification>", CHAT drew the XML as
 * the owner's bubble, and the checkpoint title was made from it. Every surface
 * that labels a prompt as yours asks isHarnessNotice first and shows
 * noticeLine instead.
 */

const NOTICE_OPEN = /^\s*<task-notification>/

/** Whether a prompt is a harness notice rather than something the owner sent. */
export function isHarnessNotice(prompt: string | null | undefined): boolean {
  return typeof prompt === 'string' && NOTICE_OPEN.test(prompt)
}

function tagText(text: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  const inner = found?.[1]?.trim() ?? ''
  return inner.length > 0 ? inner : null
}

/**
 * What the notice says, in words: its summary, else its status, else that a
 * task reported back. A head cut to its first line (`<task-notification>`
 * alone) has neither, and still reads as a sentence.
 */
export function noticeLine(prompt: string): string {
  const summary = tagText(prompt, 'summary')
  if (summary !== null) return summary.replace(/\s+/g, ' ')
  const status = tagText(prompt, 'status')
  return status !== null ? `Background task ${status}` : 'Background task reported back'
}
