/**
 * THE HARNESS A NEW AGENT TAKES (owner, 2026-11-01): the last one used to make
 * an agent, whichever way it was made; the prompt box's picker changes it.
 */

const KEY = 'cookrew.new-agent-harness'
const FALLBACK = 'Claude Code'

export function lastHarness(offered: readonly string[]): string {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    // private mode: no memory, the fallback stands
  }
  if (saved && offered.includes(saved)) return saved
  if (offered.includes(FALLBACK)) return FALLBACK
  return offered[0] ?? FALLBACK
}

export function rememberHarness(name: string): void {
  try {
    localStorage.setItem(KEY, name)
  } catch {
    // private mode: not remembered
  }
}
