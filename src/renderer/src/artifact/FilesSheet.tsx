import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileEntry, FileRoot } from '../../../main/file-server'
import { filesList, filesRaw, filesRoots } from '../remote-api'
import { ArtifactSheetPanel, ArtifactSheetView, useArtifactPreview, useSheetEscape } from './ArtifactSheet'
import { filesSheet, useOpenFiles, type FilesLocation } from './open-files'
import './files-sheet.css'

type BrowseLocation = Exclude<FilesLocation, { kind: 'file' }>
type FolderLocation = Extract<FilesLocation, { kind: 'folder' }>
type FileLocation = Extract<FilesLocation, { kind: 'file' }>
type Navigate = (location: FilesLocation) => void

export type FilesListingState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed'; readonly why: string }
  | { readonly phase: 'roots'; readonly roots: readonly FileRoot[] }
  | { readonly phase: 'folder'; readonly entries: readonly FileEntry[]; readonly truncated: boolean }

function FolderPath({ location, onOpen }: { location: FolderLocation; onOpen: Navigate }): React.JSX.Element {
  const { root, folders } = location
  return (
    <nav className="cr-files-path" aria-label="Folder path">
      <ol>
        <li><button type="button" onClick={() => onOpen({ kind: 'roots' })}>Files</button></li>
        {[root.name, ...folders].map((name, depth) => (
          <li key={depth}>
            {depth === folders.length
              ? <span aria-current="page">{name}</span>
              : <button type="button" onClick={() => onOpen({ kind: 'folder', root, folders: folders.slice(0, depth) })}>{name}</button>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

function FolderEntries({ location, entries, onOpen }: { location: FolderLocation; entries: readonly FileEntry[]; onOpen: Navigate }): React.JSX.Element {
  const { root, folders } = location
  const ordered = [...entries].sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir'))
  return (
    <ul className="cr-files-list">
      {ordered.map(({ name, kind }) => (
        <li key={name}>
          {kind === 'other'
            ? <div className="cr-files-entry"><span>{name}</span><small>Unavailable</small></div>
            : (
              <button type="button" className="cr-files-entry" onClick={() => onOpen(kind === 'dir'
                ? { kind: 'folder', root, folders: [...folders, name] }
                : { kind: 'file', root, folders, name })}>
                <span>{name}</span>
                {kind === 'dir' && <small>Folder</small>}
              </button>
            )}
        </li>
      ))}
    </ul>
  )
}

function Listing({ location, state, onOpen, onRetry }: { location: BrowseLocation; state: FilesListingState; onOpen: Navigate; onRetry?: () => void }): React.JSX.Element | null {
  if (state.phase === 'loading') return <p className="cr-artifact-note" role="status">Loading…</p>
  if (state.phase === 'failed') {
    return (
      <div className="cr-artifact-note" role="status">
        <p>{state.why}</p>
        {onRetry && <button type="button" className="cr-artifact-save" onClick={onRetry}>Try again</button>}
      </div>
    )
  }
  if (state.phase === 'roots') {
    if (state.roots.length === 0) return <p className="cr-artifact-note">This computer has no shared folders.</p>
    return (
      <ul className="cr-files-list">
        {state.roots.map((root) => (
          <li key={root.path}>
            <button type="button" className="cr-files-entry" title={root.path} onClick={() => onOpen({ kind: 'folder', root, folders: [] })}>{root.name}</button>
          </li>
        ))}
      </ul>
    )
  }
  if (location.kind !== 'folder') return null
  if (state.entries.length === 0) return <p className="cr-artifact-note">This folder is empty.</p>
  return (
    <>
      <FolderEntries location={location} entries={state.entries} onOpen={onOpen} />
      {state.truncated && <p className="cr-files-message">Only part of this folder is shown.</p>}
    </>
  )
}

export function FilesSheetView({ location, state, onBack, onClose, onOpen, onRetry }: {
  location: BrowseLocation
  state: FilesListingState
  onBack: () => void
  onClose: () => void
  onOpen: Navigate
  onRetry?: () => void
}): React.JSX.Element {
  const folder = location.kind === 'folder' ? location : null
  return (
    <ArtifactSheetPanel title="Files" onClose={onClose} onBack={folder ? onBack : undefined}>
      <div className="cr-files-browser">
        {folder && <FolderPath location={folder} onOpen={onOpen} />}
        <Listing location={location} state={state} onOpen={onOpen} onRetry={onRetry} />
      </div>
    </ArtifactSheetPanel>
  )
}

async function loadListing(location: BrowseLocation, signal: AbortSignal): Promise<FilesListingState> {
  if (location.kind === 'roots') {
    const result = await filesRoots(signal)
    return 'error' in result ? { phase: 'failed', why: result.why } : { phase: 'roots', roots: result.roots }
  }
  const result = await filesList(location.root.path, location.folders.join('/'), signal)
  return 'error' in result ? { phase: 'failed', why: result.why } : { phase: 'folder', entries: result.entries, truncated: result.truncated }
}

function FileBrowser({ location }: { location: BrowseLocation }): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ location: BrowseLocation; attempt: number; state: FilesListingState } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadListing(location, controller.signal).then(
      (state) => { if (!controller.signal.aborted) setLoaded({ location, attempt, state }) },
      (error: unknown) => {
        // Left for another folder or machine: nothing to say about this one.
        if (controller.signal.aborted || (error as Error | undefined)?.name === 'AbortError') return
        setLoaded({ location, attempt, state: { phase: 'failed', why: 'The folders could not be loaded from the computer.' } })
      }
    )
    return () => controller.abort()
  }, [location, attempt])
  const state: FilesListingState = loaded?.location === location && loaded.attempt === attempt ? loaded.state : { phase: 'loading' }
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return <FilesSheetView location={location} state={state} onBack={filesSheet.back} onClose={filesSheet.close} onOpen={filesSheet.go} onRetry={retry} />
}

function FilePreview({ location }: { location: FileLocation }): React.JSX.Element {
  const { root, folders, name } = location
  const path = [...folders, name].join('/')
  const load = useCallback(async (signal: AbortSignal) => {
    const result = await filesRaw(root.path, path, signal)
    return 'error' in result ? { kind: 'unavailable' as const, name, why: result.why } : result
  }, [root.path, path, name])
  const preview = useArtifactPreview(path, load)
  return <ArtifactSheetView title={name} onClose={filesSheet.close} onBack={filesSheet.back} {...preview} />
}

function FilesSheet({ location }: { location: FilesLocation }): React.JSX.Element {
  useSheetEscape(filesSheet.back)
  if (location.kind === 'file') return <FilePreview key={JSON.stringify([location.root.path, location.folders, location.name])} location={location} />
  return <FileBrowser location={location} />
}

export function FilesSheetHost(): React.JSX.Element | null {
  const location = useOpenFiles()
  if (location === null || typeof document === 'undefined') return null
  return createPortal(<FilesSheet location={location} />, document.body)
}
