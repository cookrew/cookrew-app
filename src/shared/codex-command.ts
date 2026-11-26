import { HARNESS_CARDS } from './harness-catalog'
/** A launch line that runs Codex (`codex …`, options and subcommands after it). */
export function isCodexCommand(command: string): boolean {
  return HARNESS_CARDS.codex.matches(command)
}
