import { useEffect, useState } from 'react'
import type {
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState
} from '../../shared/model'
import { cookrew, isRemoteMode } from './api'
import { CrIcon } from './icons'
import { GitChip } from './GitChip'
import {
  addWorkspaceDir,
  dirLabel,
  hasNativeDirPicker,
  hasWorkspaceV2,
  pickDirectory,
  removeWorkspaceDir,
  setPrimaryDir,
  setTerminalCwd,
  useTerminalCwd,
  useWorkspaceDirs
} from './workspace-v2'
import './team-fork.css'

/**
 * Directory manager for the active workspace (picker/workspace UX lane):
 * list the workspace dirs, add one via the native picker (or a text path on
 * mobile), remove, set-primary, and steer each terminal's cwd to one of the
 * dirs. Renders a git-chip slot per dir that Fresco fills. Mutations go
 * through the workspace-v2 adapter, which runs Forge's real API when present
 * and an in-memory mock otherwise (banner shown while mocked).
 */
export function DirectoryManager({
  meta: initialMeta,
  onClose
}: {
  meta: WorkspaceMeta
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [list, setList] = useState<WorkspaceList | null>(null)
  const [addPath, setAddPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void cookrew().getWorkspace().then(setState)
    return cookrew().onWorkspaceState(setState)
  }, [])

  useEffect(() => {
    void cookrew().listWorkspaces().then(setList)
    return cookrew().onWorkspaceList(setList)
  }, [])

  // Track the meta live so real-API dir changes (broadcast on the workspace
  // list) refresh the panel instead of showing the snapshot from open time.
  const meta = list?.workspaces.find((w) => w.id === initialMeta.id) ?? initialMeta
  const isActive = list ? list.activeId === meta.id : true
  const dirs = useWorkspaceDirs(meta)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  // Terminals belong to the ACTIVE workspace (getWorkspace); only surface
  // them (and the in-use dir guard) when managing that workspace.
  const terminals = (
    isActive ? (state?.nodes.filter((n) => n.kind === 'terminal') ?? []) : []
  ) as TerminalNodeData[]
  // A dir is pinned open while a terminal sits in it — can't be removed.
  const inUse = new Set(terminals.map((t) => t.cwd))

  const run = (op: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void op()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const addViaPicker = (): void => {
    run(async () => {
      const picked = await pickDirectory()
      if (picked) await addWorkspaceDir(meta, picked)
    })
  }

  const addViaText = (): void => {
    const path = addPath.trim()
    if (!path) return
    run(async () => {
      await addWorkspaceDir(meta, path)
      setAddPath('')
    })
  }

  return (
    <div className="tf-scrim" onClick={onClose}>
      <div className="tf-panel dm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tf-head">
          <CrIcon name="terminal" />
          <span className="tf-title">DIRECTORIES · {meta.name.toUpperCase()}</span>
          <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
            <CrIcon name="close" />
          </button>
        </div>

        {!hasWorkspaceV2() && (
          <div className="tf-banner">
            MULTI-DIR API NOT WIRED YET — changes preview locally; execution lands with Forge&apos;s
            backend.
          </div>
        )}

        <div className="dm-section-label">WORKSPACE DIRECTORIES</div>
        <div className="dm-list">
          {dirs.map((dir, i) => {
            const isPrimary = i === 0
            const used = inUse.has(dir)
            const canRemove = dirs.length > 1 && !used
            return (
              <div key={dir} className="dm-row">
                <button
                  className={`dm-star${isPrimary ? ' on' : ''}`}
                  title={isPrimary ? 'Primary directory' : 'Set as primary'}
                  disabled={isPrimary || busy}
                  onClick={() => run(() => setPrimaryDir(meta, dir))}
                >
                  {isPrimary ? '★' : '☆'}
                </button>
                <span className="dm-dir-text">
                  <span className="dm-dir-name">{dirLabel(dir)}</span>
                  <span className="dm-dir-path" title={dir}>
                    {dir}
                  </span>
                </span>
                {/* Fresco git visuals: self-sources via gitInfo(dir). */}
                <span className="dm-git-slot" data-dir={dir}>
                  <GitChip dir={dir} onCream />
                </span>
                {isPrimary && <span className="cr-chip amber dm-primary-chip">PRIMARY</span>}
                <button
                  className="cr-btn sm icon dm-remove"
                  title={
                    used
                      ? 'A terminal is using this directory'
                      : dirs.length <= 1
                        ? 'A workspace needs at least one directory'
                        : 'Remove directory'
                  }
                  disabled={!canRemove || busy}
                  onClick={() => run(() => removeWorkspaceDir(meta, dir))}
                >
                  <CrIcon name="close" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="dm-add">
          {hasNativeDirPicker() ? (
            <button className="cr-btn sm" disabled={busy} onClick={addViaPicker}>
              <CrIcon name="plus" /> ADD DIRECTORY…
            </button>
          ) : (
            <>
              <input
                className="tf-input"
                placeholder={isRemoteMode() ? '/absolute/path/on/host' : '/absolute/path'}
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addViaText()}
              />
              <button className="cr-btn sm" disabled={busy || !addPath.trim()} onClick={addViaText}>
                ADD
              </button>
            </>
          )}
        </div>

        {isActive ? (
          terminals.length > 0 && (
            <>
              <div className="dm-section-label">TERMINAL WORKING DIRECTORIES</div>
              <div className="dm-list">
                {terminals.map((term) => (
                  <TerminalCwdRow key={term.id} node={term} dirs={dirs} busy={busy} onRun={run} />
                ))}
              </div>
            </>
          )
        ) : (
          <div className="tf-role-note">
            Switch to this workspace to set its terminals&apos; directories.
          </div>
        )}

        {error && <div className="tf-error">{error}</div>}

        <div className="tf-foot">
          <span className="dm-foot-note">
            {dirs.length} director{dirs.length === 1 ? 'y' : 'ies'} · {terminals.length} agent
            {terminals.length === 1 ? '' : 's'}
          </span>
          <button className="cr-btn sm primary" onClick={onClose}>
            DONE
          </button>
        </div>
      </div>
    </div>
  )
}

/** One terminal row: name + a cwd dropdown restricted to workspace dirs. */
function TerminalCwdRow({
  node,
  dirs,
  busy,
  onRun
}: {
  node: TerminalNodeData
  dirs: string[]
  busy: boolean
  onRun: (op: () => Promise<void>) => void
}): React.JSX.Element {
  const cwd = useTerminalCwd(node, dirs)
  return (
    <div className="dm-row">
      <span className="dm-term-icon">
        <CrIcon name="agent" />
      </span>
      <span className="dm-dir-text">
        <span className="dm-dir-name">{node.name}</span>
      </span>
      <select
        className="dm-cwd-select"
        value={cwd}
        disabled={busy || dirs.length <= 1}
        onChange={(e) => {
          const dir = e.target.value
          onRun(() => setTerminalCwd(node.id, dir))
        }}
      >
        {dirs.map((dir) => (
          <option key={dir} value={dir}>
            {dirLabel(dir)}
          </option>
        ))}
      </select>
    </div>
  )
}
