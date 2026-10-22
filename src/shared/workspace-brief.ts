// THE OWNER'S BRIEF: one line about the project a workspace holds. It decides
// the workspace's traits on cookrew.dev (main/levels/traits.ts), and is never
// sent there itself. Checked here, once, for the desktop, the phone and the
// store alike.

/** Characters a brief holds at most, counted after it is made one line. */
export const BRIEF_MAX = 140

export type BriefCheck = { ok: true; brief: string } | { ok: false; reason: string }

/** Control characters and every run of whitespace (newlines too) become one space; the ends are trimmed. */
export const oneLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The brief as stored: '' means unset. */
export function checkBrief(raw: unknown): BriefCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'A brief is one line of text' }
  const brief = oneLine(raw)
  if (brief.length > BRIEF_MAX) return { ok: false, reason: `A brief is at most ${BRIEF_MAX} characters` }
  return { ok: true, brief }
}
