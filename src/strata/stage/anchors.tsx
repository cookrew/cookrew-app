// Anchors: every drawn item registers its element under an AnchorId with the
// scene it is drawn in. Each mounted scene has its own registry, because the
// same id can be drawn twice during a flight (a container in the workspaces
// level and the same container, big, in the agents level). The stage reads
// the rects once per flight, at take-off.
import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'
import type { AnchorId } from '../../shared/strata'
import type { UseAnchor } from '../seams'

export interface AnchorRegistry {
  get(id: AnchorId): Element | undefined
  set(id: AnchorId, el: Element): void
  /** Only forgets `el` if it is still the one registered (a re-render may have registered a newer one). */
  drop(id: AnchorId, el: Element): void
}

export const createRegistry = (): AnchorRegistry => {
  const els = new Map<AnchorId, Element>()
  return {
    get: (id) => els.get(id),
    set: (id, el) => void els.set(id, el),
    drop: (id, el) => {
      if (els.get(id) === el) els.delete(id)
    }
  }
}

const SceneAnchors = createContext<AnchorRegistry | null>(null)

export function SceneAnchorsProvider({ registry, children }: { registry: AnchorRegistry; children: ReactNode }) {
  return <SceneAnchors.Provider value={registry}>{children}</SceneAnchors.Provider>
}

/** `ref={useAnchor('agent:' + id)}` on the element whose rect the camera flies to. Outside a stage it is a no-op. */
export const useAnchor: UseAnchor = (id) => {
  const registry = useContext(SceneAnchors)
  // React calls a ref with null on detach; remember what it attached so the detach drops only that.
  const attached = useRef<Element | null>(null)
  return useCallback(
    (el: Element | null) => {
      if (!registry) return
      if (el) registry.set(id, el)
      else if (attached.current) registry.drop(id, attached.current)
      attached.current = el
    },
    [registry, id]
  )
}

/** The first registered and connected anchor among `ids`. */
export const findAnchor = (registry: AnchorRegistry | undefined, ids: readonly AnchorId[]): { id: AnchorId; el: Element } | null => {
  if (!registry) return null
  for (const id of ids) {
    const el = registry.get(id)
    if (el?.isConnected) return { id, el }
  }
  return null
}
