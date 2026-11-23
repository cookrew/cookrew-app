import { useSyncExternalStore } from 'react'
import type { FileRoot } from '../../../main/file-server'
import { registerScopeState } from '../machine-scope'
import { closeArtifact } from './open-artifact'

export type FilesLocation =
  | { readonly kind: 'roots' }
  | { readonly kind: 'folder'; readonly root: FileRoot; readonly folders: readonly string[] }
  | { readonly kind: 'file'; readonly root: FileRoot; readonly folders: readonly string[]; readonly name: string }

const ROOTS: FilesLocation = { kind: 'roots' }
let current: FilesLocation | null = null
const listeners = new Set<() => void>()

function publish(next: FilesLocation | null): void {
  if (current === next) return
  current = next
  for (const listener of listeners) listener()
}

export const filesSheet = {
  get: (): FilesLocation | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  open(): void {
    closeArtifact()
    publish(ROOTS)
  },
  close(): void {
    publish(null)
  },
  go(location: FilesLocation): void {
    if (current !== null) publish(location)
  },
  back(): void {
    if (current === null || current.kind === 'roots') return publish(null)
    const { root, folders } = current
    if (current.kind === 'file') return publish({ kind: 'folder', root, folders })
    if (folders.length === 0) return publish(ROOTS)
    publish({ kind: 'folder', root, folders: folders.slice(0, -1) })
  }
}

export function useOpenFiles(): FilesLocation | null {
  return useSyncExternalStore(filesSheet.subscribe, filesSheet.get, filesSheet.get)
}

registerScopeState('files sheet', filesSheet.close)
