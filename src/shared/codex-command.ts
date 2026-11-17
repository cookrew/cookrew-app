/** A launch line that runs Codex (`codex …`, options and subcommands after it). */
export function isCodexCommand(command: string): boolean {
  return /^\s*codex\b/.test(command)
}
