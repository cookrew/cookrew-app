// Codex runs INLINE in a Cookrew pane: no alternate screen, history in the
// pane's own scrollback, the same shape as Claude Code.
//
// Codex 0.167+ on the alternate screen owns a fullscreen transcript, and that
// transcript pins the prompt of the answer on screen as ONE top row cut to the
// width with "…" (codex-rs/tui/src/transcript_view/prompt_header.rs). It has no
// switch of its own. At a phone's 43 columns nearly every prompt is longer than
// a row, so LIVE showed every prompt cut off above the middle of its answer.
// The alternate screen also leaves herdr no scrollback, so LIVE's local scroll
// (live-scroll.ts) had no history to seed.
//
// Inline, Codex writes history into the pane's scrollback and, on a width
// change, clears it and writes it again at the new width (capped at 1000
// rows). Measured 2026-11-13 on herdr 0.9.5 with codex 0.167.1: thirty zoom-
// sized resizes left one copy of every line, every row within 43 columns.
//
// The `-c` form, not `--no-alt-screen`: codex takes `-c` before a subcommand
// as well as without one, the same way the route's own `-c` args ride along.

import { isCodexCommand } from './codex-bind'

export const CODEX_INLINE_FLAG = '-c tui.alternate_screen=never'

/** A card that already chose a screen mode keeps it (an option, not a word in a prompt). */
const CHOSE_SCREEN = /(?:^|\s)(?:--no-alt-screen|-c\s+['"]?tui\.alternate_screen=)/

/** The codex launch line, set to run inline; any other command as it was. */
export function codexInlineLine(command: string): string {
  if (!isCodexCommand(command) || CHOSE_SCREEN.test(command)) return command
  return command.replace(/^(\s*codex)(?=\s|$)/, `$1 ${CODEX_INLINE_FLAG}`)
}
