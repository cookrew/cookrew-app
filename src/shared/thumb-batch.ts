/**
 * Ids one thumb batch may name (GET /api/browser/thumbs). The viewport rarely
 * holds more than a dozen browser cards; the companion caps at this and the
 * phone never asks for more, so the two agree by construction.
 */
export const THUMB_BATCH_MAX = 24

/**
 * How long the companion waits for one thumb batch before letting it go: a
 * batch held open holds one of its six HTTP/1.1 connections (2026-11-01).
 * The Mac answers within its own capture wait (browser-thumb-cache.ts), so
 * only a batch that is truly stuck reaches this.
 */
export const THUMB_BATCH_TIMEOUT_MS = 8000
