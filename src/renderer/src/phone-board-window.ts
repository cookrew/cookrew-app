/** Phone Board rows mounted at once: roughly one viewport plus overscan. */
export const PHONE_BOARD_PAGE_SIZE = 12
/** Enough recent cross-workspace history to rank the phone Board without a 1 MB object graph. */
export const PHONE_BOARD_EVENT_LIMIT = 256
/** Preserve the desktop Board's existing history depth. */
export const DESKTOP_BOARD_EVENT_LIMIT = 4000

export interface PhoneBoardWindow<T> {
  visible: readonly T[]
  remaining: number
}

/**
 * Keep the desktop Board unchanged while bounding the phone's mounted rows.
 * The source array remains complete; the next page only widens the render
 * window, so search/order/selection semantics do not fork by client.
 */
export function phoneBoardWindow<T>(
  rows: readonly T[],
  limit: number,
  enabled: boolean,
): PhoneBoardWindow<T> {
  const end = enabled
    ? Math.min(rows.length, Math.max(0, Math.floor(limit)))
    : rows.length
  return {
    visible: rows.slice(0, end),
    remaining: rows.length - end,
  }
}

/** Advance one bounded page without ever exceeding the available rows. */
export function nextPhoneBoardLimit(total: number, current: number): number {
  return Math.min(
    Math.max(0, Math.floor(total)),
    Math.max(0, Math.floor(current)) + PHONE_BOARD_PAGE_SIZE,
  )
}

export function boardEventLimit(phone: boolean): number {
  return phone ? PHONE_BOARD_EVENT_LIMIT : DESKTOP_BOARD_EVENT_LIMIT
}

/** Keep the live event tail bounded for however long the Board remains open. */
export function appendBoardEvent<T>(events: readonly T[], event: T, limit: number): T[] {
  const bounded = Math.max(1, Math.floor(limit))
  return events.length < bounded
    ? [...events, event]
    : [...events.slice(events.length - bounded + 1), event]
}
