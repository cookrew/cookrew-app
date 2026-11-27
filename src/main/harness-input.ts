// HOW EACH HARNESS TAKES TYPED INPUT (harness-integration-contract): what
// its drawn input box looks like, whether every input waits for it, and the
// key that submits a line on a direct (non-herdr) backend. One entry per
// HarnessId and no default: a new harness cannot be typed into before it
// says what "ready" looks like on its screen — the old `default: true`
// let a paste land on a blank screen and answer the trust or sign-in row.

import type { HarnessId } from '../shared/harness-catalog'
import { harnessFor } from './harness'

/**
 * HAS CLAUDE DRAWN ITS INPUT BOX? (2026-11-01: a prompt made from the global
 * box arrived as "gent prompt inputbox…".) The pane runs `clear; exec claude`,
 * and node can sit silent for longer than BOOT_QUIET_MS before Claude draws
 * anything: the quiet came before the TUI read its input, and the paste's
 * first character went with the terminal's mode switch. So a Claude session
 * also waits for its composer — the prompt mark between the box's two rules,
 * or the hint line under it.
 */
export function claudeComposerDrawn(screen: string): boolean {
  const lines = screen.split('\n')
  if (lines.some((line) => /\? for shortcuts|bypass(?:ing)? permissions|shift\+tab to cycle/i.test(line))) return true
  return lines.some((line) => /^\s*[─━]{10,}\s*$/.test(line)) && lines.some((line) => /^\s*(?:│\s*)?[❯>]\s?/.test(line))
}

/**
 * HAS CODEX DRAWN ITS INPUT LINE? Quiet proves nothing for it: 1.5 s of silence
 * can be a blank screen, and keys queued there answer the trust or sign-in row
 * when it appears. Read off a real 0.166 boot: `› Ask Codex…`, `? for shortcuts`.
 */
export function codexComposerDrawn(screen: string): boolean {
  return screen.split('\n').some((line) => /^\s*›\s+\D/.test(line) || /\? for shortcuts/.test(line))
}

/** Pi's footer, read off a real 1.4 boot: `0.0%/128k (auto)`. It asks nothing first. */
export function piComposerDrawn(screen: string): boolean {
  return /\d(?:\.\d+)?%\/\d+k\b/.test(screen)
}

/**
 * OpenCode's input could not be read off a real boot (its one service per
 * machine was in use), so that is only "past its server start".
 */
export function opencodeComposerDrawn(screen: string): boolean {
  return screen.trim() !== '' && !/starting background server/i.test(screen)
}

/**
 * Antigravity CLI's input box, read off real 1.5.18 boots: a `>` row between
 * two rules over the `? for shortcuts` footer. Until it is drawn the screen
 * holds a spinner (the sign-in check) or the first-boot banner.
 */
export function agyComposerDrawn(screen: string): boolean {
  return /\? for shortcuts/.test(screen)
}

/**
 * Devin's input box, read off real 3000.14 boots: a rule, then the `❭` row
 * ("❭ Ask Devin to build features…" while empty), then a rule. Its approval
 * selector draws `❭` rows too, with no rule straight above the cursor row.
 */
export function devinComposerDrawn(screen: string): boolean {
  const lines = screen.split('\n')
  return lines.some((line, at) => /^❭(?:\s|$)/.test(line) && at > 0 && /^[─━]{10,}/.test(lines[at - 1]))
}

/** Cookrew's ACP host (cli/cookrew-acp.mjs): its box sits over a `⏎ send` footer, drawn once the agent's session is open. */
export function hostedComposerDrawn(screen: string): boolean {
  return /⏎ send/.test(screen)
}

export interface HarnessInput {
  /** Its input box is drawn on this screen. */
  drawn: (screen: string) => boolean
  /**
   * Every typed input (fork preamble, recruit brief, wake) waits for `drawn`,
   * not only a first task. Claude's node boot can sit silent past the quiet
   * window before its box exists, so quiet alone is not enough for it.
   */
  gatesEveryInput: boolean
  /**
   * The submit key on a direct backend. '\n' is followed by a delayed '\r'
   * confirmation (ask.ts): pi's editor under a raw pty took '\r' as a newline.
   */
  directSubmit: '\r' | '\n'
}

export const HARNESS_INPUT: Readonly<Record<HarnessId, HarnessInput>> = {
  claude: { drawn: claudeComposerDrawn, gatesEveryInput: true, directSubmit: '\r' },
  codex: { drawn: codexComposerDrawn, gatesEveryInput: false, directSubmit: '\r' },
  opencode: { drawn: opencodeComposerDrawn, gatesEveryInput: false, directSubmit: '\r' },
  pi: { drawn: piComposerDrawn, gatesEveryInput: false, directSubmit: '\n' },
  // Every input waits: keys sent during its sign-in spinner are lost (measured 2026-11-26).
  agy: { drawn: agyComposerDrawn, gatesEveryInput: true, directSubmit: '\r' },
  // It signs in and asks about Git first: every input waits for its box.
  devin: { drawn: devinComposerDrawn, gatesEveryInput: true, directSubmit: '\r' },
  // The host queues what arrives early, but a first task still waits for the session it opens.
  dsh: { drawn: hostedComposerDrawn, gatesEveryInput: true, directSubmit: '\r' }
}

/** The input facts for a launch command, or null for a plain shell. */
export function inputFor(command: string): HarnessInput | null {
  const harness = harnessFor(command)
  return harness ? HARNESS_INPUT[harness.id] : null
}
