/**
 * IS A HITL BAR MOUNTED (phase 6, plan docs/hitl-cross-workspace-2026-11-15 ·
 * v6.2): while one is, the account's other machines are read slowly for what
 * needs the owner there (zoom/remote-hitl.ts), their fleet through the page's
 * one fleet store (use-zoom-fleet.ts · remoteBackground) and their log through
 * the bar's own feed. A claim per mounted bar; the last one let go stops both.
 */

export interface HitlWant {
  now: () => boolean
  watch: (changed: () => void) => () => void
  /** Held until the returned release is called (once; a second call does nothing). */
  claim: () => () => void
}

export function createHitlWant(): HitlWant {
  let claims = 0
  const listeners = new Set<() => void>()
  const tell = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    now: () => claims > 0,
    watch(changed) {
      listeners.add(changed)
      return () => void listeners.delete(changed)
    },
    claim() {
      claims += 1
      if (claims === 1) tell()
      let held = true
      return () => {
        if (!held) return
        held = false
        claims -= 1
        if (claims === 0) tell()
      }
    }
  }
}

/** The page's one want: the bar claims it (BarGroups.tsx), the fleet store and the log feed follow it. */
export const hitlWant: HitlWant = createHitlWant()
