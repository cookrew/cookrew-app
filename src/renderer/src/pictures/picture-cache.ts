import { imageRefKey, type ImageBytes, type ImageRef } from '../../../shared/prompt-images'

/**
 * A PROMPT'S PICTURES, ONCE EACH (owner, 2026-11-01: lazy). A picture is read
 * the first time a view scrolls to it and kept as an object URL, so scrolling
 * back, or the same screenshot in the prompt box and then in the turn it was
 * sent with, reads it once. The oldest let go past a bound, so a long
 * scrolled transcript does not hold every picture it ever showed.
 */

/** How many pictures stay loaded. */
export const KEPT = 80

export type PictureReader = (ref: ImageRef) => Promise<ImageBytes | null>

/** The cache: key → the object URL on its way (null: nothing to draw). Oldest first. */
export interface PictureCache {
  load: (ref: ImageRef) => Promise<string | null>
  /** Every picture is let go of, and its object URL given back. */
  clear: () => void
}

export function createPictureCache(
  read: PictureReader,
  urls: { create: (blob: Blob) => string; revoke: (url: string) => void } = { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
  kept = KEPT
): PictureCache {
  let held: ReadonlyMap<string, Promise<string | null>> = new Map()
  const letGo = (entries: ReadonlyArray<Promise<string | null>>): void => {
    for (const gone of entries) void gone.then((url) => url && urls.revoke(url))
  }
  return {
    load(ref) {
      const key = imageRefKey(ref)
      const known = held.get(key)
      const next = new Map(held)
      next.delete(key)
      const loading =
        known ??
        read(ref)
          .then((image) => (image ? urls.create(new Blob([image.bytes.slice().buffer], { type: image.mime })) : null))
          .catch((error: unknown) => {
            console.error('Picture read failed:', error)
            return null
          })
      next.set(key, loading)
      const over = Math.max(0, next.size - kept)
      const oldest = [...next.keys()].slice(0, over)
      letGo(oldest.map((k) => next.get(k) as Promise<string | null>))
      for (const k of oldest) next.delete(k)
      held = next
      return loading
    },
    clear() {
      letGo([...held.values()])
      held = new Map()
    }
  }
}
