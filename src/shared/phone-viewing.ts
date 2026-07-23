// Phone-viewing tracker (mobile browser capture): a phone renders a browser
// card from the desktop's live capturePage() frames, polling
// GET /api/browser/:id/thumb. Each poll is a heartbeat that says "a phone is
// viewing this browser right now" — the desktop uses it to keep capturing even
// when its own window is hidden/occluded (otherwise the phone goes blank).
//
// Pure + immutable so it unit-tests without Electron and is safe to share
// between the main process (marks on each /thumb request) and the renderer
// (decides whether the capture loop stays alive).

/**
 * TTL past the last poll during which a browser still counts as phone-viewed.
 * The phone polls every ~5s; 8s tolerates a couple of dropped polls without
 * blanking, while still letting capture fall back to paused soon after the
 * phone navigates away.
 */
export const PHONE_VIEW_TTL_MS = 8000

/** browserId -> epoch ms of its most recent phone /thumb poll. */
export type ViewerClocks = Readonly<Record<string, number>>

/** Record (or refresh) `id` as viewed at `now`. Returns a new object. */
export function markViewed(state: ViewerClocks, id: string, now: number): ViewerClocks {
  return { ...state, [id]: now }
}

/** Was `id` polled within `ttlMs` of `now`? */
export function isViewed(
  state: ViewerClocks,
  id: string,
  now: number,
  ttlMs: number = PHONE_VIEW_TTL_MS
): boolean {
  const last = state[id]
  return last !== undefined && now - last < ttlMs
}

/** The ids still within their TTL at `now`. */
export function activeViewers(
  state: ViewerClocks,
  now: number,
  ttlMs: number = PHONE_VIEW_TTL_MS
): string[] {
  return Object.keys(state).filter((id) => isViewed(state, id, now, ttlMs))
}

/** Drop ids whose TTL has lapsed. Returns a new object. */
export function pruneViewers(
  state: ViewerClocks,
  now: number,
  ttlMs: number = PHONE_VIEW_TTL_MS
): ViewerClocks {
  return Object.fromEntries(
    Object.entries(state).filter(([id]) => isViewed(state, id, now, ttlMs))
  )
}
