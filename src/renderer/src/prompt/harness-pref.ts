/**
 * THE HARNESS A NEW AGENT TAKES (owner, 2026-11-01): the last one used to make
 * an agent, whichever way it was made; the prompt box's picker changes it.
 */

/** A bare shell: made from the ＋ menu, never the box's harness (it takes no prompt). */
export const SHELL_PRESET = 'Shell'

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

const listeners = new Set<() => void>()

export function onHarnessPref(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function rememberHarness(name: string): void {
  // A shell opened from the menu leaves the harness the box was on.
  if (name === SHELL_PRESET) return
  try {
    localStorage.setItem(KEY, name)
  } catch {
    // private mode: not remembered
  }
  for (const listener of listeners) listener()
}
