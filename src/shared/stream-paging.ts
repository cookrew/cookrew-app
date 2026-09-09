// INDEX PAGING, BY IDENTITY (one-stream T2.5, panel C — "index 也分页").
//
// Codex's protocol says the same thing twice: thread/read (the whole
// conversation in one answer) is marked deprecated — "prefer a metadata-only
// read and page with thread/turns/list and thread/items/list" — and every
// paged list returns BOTH next_cursor and backwards_cursor, so a client can
// walk in either direction from wherever it opened. thread/resume goes one
// step further and embeds initial_turns_page, so opening a conversation is one
// round trip and not two.
//
// WHY A CURSOR IS AN IDENTITY AND NEVER AN OFFSET. The same rule /stream
// already follows for block windows (stream.ts): a page named by an array
// offset shifts under its caller the moment the stream grows, which is how a
// pager duplicates or skips a page. A page named by the identity at one of its
// ends cannot. The trade is stated: an identity the list does not hold is
// answered as `unknown*` rather than silently falling back to an end.
//
// THE DEFAULT WINDOW IS THE NEWEST PAGE, not the oldest. A rail opens at the
// bottom of a conversation and is read upwards; starting at ordinal 1 of a
// 1,232-checkpoint card would mean paging forward through the whole history to
// reach what the agent just did.

/** Codex's own page size for a turns list, and the design's stated default. */
export const STREAM_INDEX_PAGE_LIMIT = 100
/** One page is a rail's worth of rows, not a history. */
export const MAX_STREAM_INDEX_PAGE = 500

export interface IndexPageRequest {
  /** The rows immediately NEWER than this identity. */
  after?: string
  /** The rows immediately OLDER than this identity. */
  before?: string
  limit?: number
}

export interface IndexPage<T> {
  rows: T[]
  /** Pass as `after=` for the next page towards the newest end; null when the
   *  page already ends there. */
  nextCursor: string | null
  /** Pass as `before=` for the next page towards the oldest end; null when the
   *  page already starts there. */
  backwardsCursor: string | null
  /** Length of the WHOLE list, so a virtualizer can size itself. */
  total: number
  /** The cursor named an identity this list does not hold. Said out loud. */
  unknownAfter?: true
  unknownBefore?: true
}

/** ?limit=, clamped. A missing or unusable value is the default, never NaN. */
export function indexPageLimit(raw: string | null): number {
  const parsed = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(parsed)) return STREAM_INDEX_PAGE_LIMIT
  return Math.max(1, Math.min(Math.floor(parsed), MAX_STREAM_INDEX_PAGE))
}

/**
 * One page of an ordered, identity-keyed list.
 *
 * EXHAUSTIVE AND NON-OVERLAPPING, which is the property a rail's backwards
 * scroll depends on: starting from the default page and following
 * `backwardsCursor` until it is null visits every row exactly once, and the
 * same is true forward through `nextCursor`. The cursors are EXCLUSIVE ends —
 * the row a cursor names is the last row of the page you already have.
 */
export function pageByIdentity<T extends { identity: string }>(
  rows: readonly T[],
  request: IndexPageRequest = {}
): IndexPage<T> {
  const total = rows.length
  const limit = Math.max(1, Math.min(request.limit ?? STREAM_INDEX_PAGE_LIMIT, MAX_STREAM_INDEX_PAGE))
  if (request.after !== undefined) {
    const at = rows.findIndex((row) => row.identity === request.after)
    if (at < 0) return { rows: [], nextCursor: null, backwardsCursor: null, total, unknownAfter: true }
    return cursored(rows, at + 1, Math.min(total, at + 1 + limit), total)
  }
  if (request.before !== undefined) {
    const at = rows.findIndex((row) => row.identity === request.before)
    if (at < 0) {
      return { rows: [], nextCursor: null, backwardsCursor: null, total, unknownBefore: true }
    }
    // SHORT at the start rather than shifted forward: a caller that asked for
    // the page before row 3 must never be handed row 4.
    return cursored(rows, Math.max(0, at - limit), at, total)
  }
  return cursored(rows, Math.max(0, total - limit), total, total)
}

function cursored<T extends { identity: string }>(
  rows: readonly T[],
  from: number,
  to: number,
  total: number
): IndexPage<T> {
  const page = rows.slice(from, to)
  return {
    rows: page,
    nextCursor: to < total && page.length > 0 ? page[page.length - 1].identity : null,
    backwardsCursor: from > 0 && page.length > 0 ? page[0].identity : null,
    total
  }
}
