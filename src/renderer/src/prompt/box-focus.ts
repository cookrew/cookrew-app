/**
 * The prompt box's caret, for what stands outside it: a waiting agent's Esc
 * row ("No, and tell it what to do differently") sends Esc and hands over to
 * typing, from the box's own menu and from a bar group's card alike
 * (WaitChoices.tsx). The mounted box registers how it takes focus.
 */

let focuser: (() => void) | null = null

export const promptBox = {
  /** The box mounts its focus here; the returned call takes it back. */
  register(focus: () => void): () => void {
    focuser = focus
    return () => {
      if (focuser === focus) focuser = null
    }
  },
  focus(): void {
    focuser?.()
  }
}
