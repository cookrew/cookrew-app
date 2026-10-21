// STAND-IN anchor registry until the stage (Glide) lands: every drawn item
// registers its element under its AnchorId; the stage reads rects once per
// flight. Same UseAnchor signature as the seam, so the swap is one import.
import type { AnchorId } from '../../shared/strata'
import type { UseAnchor } from '../seams'

const elements = new Map<AnchorId, Element>()
const refs = new Map<AnchorId, (el: Element | null) => void>()

/** Stable callback ref per id, so React does not re-run it every render. */
export const useAnchor: UseAnchor = (id) => {
  const known = refs.get(id)
  if (known) return known
  const ref = (el: Element | null) => {
    if (el) elements.set(id, el)
    else elements.delete(id)
  }
  refs.set(id, ref)
  return ref
}

/** For the stage stand-in and tests: the element registered under an id, if mounted. */
export const anchorElement = (id: AnchorId): Element | null => elements.get(id) ?? null

export const anchorIds = (): AnchorId[] => [...elements.keys()]
