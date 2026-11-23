import { useSyncExternalStore } from 'react'
import { registerScopeState } from '../machine-scope'

/**
 * WHICH ARTIFACT THE SHEET IS SHOWING, if any. A card asks (zoom/BarCards.tsx ·
 * Open here) and App mounts the sheet (ArtifactSheet.tsx · ArtifactSheetHost),
 * so the sheet is never drawn inside the small card that opened it.
 *
 * One machine's card: entering another machine closes it (machine-scope.ts).
 */

export interface OpenArtifact {
  readonly id: string
  /** The card's name, for the title and as the file name when the route's header cannot be read. */
  readonly name: string
}

let current: OpenArtifact | null = null
const listeners = new Set<() => void>()

const publish = (next: OpenArtifact | null): void => {
  current = next
  for (const listener of listeners) listener()
}

export const artifactSheet = {
  get: (): OpenArtifact | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  open(id: string, name: string): void {
    publish({ id, name })
  },
  close(): void {
    if (current !== null) publish(null)
  }
}

export const openArtifact = (id: string, name: string): void => artifactSheet.open(id, name)
export const closeArtifact = (): void => artifactSheet.close()

export function useOpenArtifact(): OpenArtifact | null {
  return useSyncExternalStore(artifactSheet.subscribe, artifactSheet.get, artifactSheet.get)
}

registerScopeState('artifact sheet', closeArtifact)
