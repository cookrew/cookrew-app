/**
 * THE FIRST-RUN CARD CLOSES FOR GOOD (D8).
 *
 * One flag, on this Mac, read once at mount and written once on NOT NOW. It
 * is not in account.json — the card exists precisely when there is no such
 * file — and it is not in the workspace store, because a person who deleted
 * every workspace has not asked to be welcomed again. localStorage is the
 * renderer's own drawer and survives everything short of a reinstall, which
 * is the one event that should raise the card again.
 *
 * NOTHING HERE THROWS. Storage can be refused (a locked-down profile, a
 * private window in some embedders); the answer then is "not dismissed", and
 * the card shows once more, which is the harmless direction to be wrong in.
 */
const DISMISSED_KEY = 'cookrew.account.first-run.dismissed'

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export const firstRunDismissed = (): boolean => {
  try {
    return storage()?.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export const dismissFirstRun = (): void => {
  try {
    storage()?.setItem(DISMISSED_KEY, '1')
  } catch {
    // Refused storage is a card that shows once more, never a broken canvas.
  }
}
