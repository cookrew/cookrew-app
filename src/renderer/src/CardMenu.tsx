import { useEffect, useRef, useState } from 'react'
import type { CanvasNode, NoteNodeData, TerminalNodeData, WorkspaceState } from '../../shared/model'
import type { TurnRecord } from '../../shared/turn'
import { cookrew, isDemoMode, isRemoteMode } from './api'
import { cardAffordances } from './card-affordances'
import { hasRoleFromCheckpoint, saveRoleFromCheckpoint } from './role-checkpoint'
import { CrIcon } from './icons'

/**
 * The card edit menu — right-click (mouse) or long-press (touch) on any
 * canvas card. One menu for every card kind; terminals grow the session
 * actions:
 *
 *   RENAME         the card's display name (notes: pins the name against
 *                  content-driven renames via customName).
 *   SAVE ROLE ▸    pick a checkpoint, name it — the role carries its
 *                  checkpoint provenance (role-checkpoint.ts).
 *   FORK ▸         clone this agent from a checkpoint onto a new card.
 *   WORKDIR ▸      move the card to another directory (respawns the agent
 *                  there — the workdir chip on the full view does the same).
 *
 * The menu is modeless chrome: outside tap or Escape dismisses, and App
 * drops it the moment its card leaves the canvas.
 */

export interface CardMenuAnchor {
  nodeId: string
  /** Viewport coordinates the menu opens at (pointer position). */
  x: number
  y: number
}

type Mode = 'root' | 'rename' | 'role' | 'fork' | 'workdir'

const MENU_W = 252
const MENU_H = 340

export function CardMenu({
  anchor,
  workspace,
  onClose
}: {
  anchor: CardMenuAnchor
  workspace: WorkspaceState
  onClose: () => void
}): React.JSX.Element | null {
  const node = workspace.nodes.find((n) => n.id === anchor.nodeId)
  const [mode, setMode] = useState<Mode>('root')
  const ref = useRef<HTMLDivElement>(null)

  // Modeless dismiss: any outside press or Escape. Capture phase so the
  // menu closes before the press lands on whatever is underneath.
  useEffect(() => {
    const onPointer = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  if (!node) return null

  const terminal = node.kind === 'terminal' ? (node as TerminalNodeData) : null
  const api = cookrew()
  const can = cardAffordances(node, {
    listTurns: typeof api.listTurns === 'function',
    roleFromCheckpoint: hasRoleFromCheckpoint()
  })

  const go = (next: Mode) => (): void => setMode(next)

  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(anchor.x, window.innerWidth - MENU_W - 8)),
    top: Math.max(8, Math.min(anchor.y, window.innerHeight - MENU_H - 8))
  }

  return (
    <div className="cr-cardmenu" style={style} ref={ref} role="menu" aria-label={`Edit ${node.name}`}>
      <div className="cr-cardmenu-head">
        {mode !== 'root' && (
          <button className="cr-cardmenu-back" aria-label="Back" onClick={go('root')}>
            <CrIcon name="prev" />
          </button>
        )}
        <span className="cr-cardmenu-title">
          {mode === 'root' && node.name}
          {mode === 'rename' && 'RENAME'}
          {mode === 'role' && 'SAVE ROLE'}
          {mode === 'fork' && 'FORK FROM CHECKPOINT'}
          {mode === 'workdir' && 'WORKDIR'}
        </span>
        <button className="cr-cardmenu-back" aria-label="Close" onClick={onClose}>
          <CrIcon name="close" />
        </button>
      </div>

      {mode === 'root' && (
        <div className="cr-cardmenu-list">
          <button className="cr-cardmenu-item" onClick={go('rename')}>
            RENAME <span className="cr-cardmenu-sub">{node.name}</span>
          </button>
          {can.role && (
            <button className="cr-cardmenu-item" onClick={go('role')}>
              SAVE ROLE <span className="cr-cardmenu-sub">from a checkpoint</span>
            </button>
          )}
          {can.fork && (
            <button className="cr-cardmenu-item" onClick={go('fork')}>
              FORK <span className="cr-cardmenu-sub">from a checkpoint</span>
            </button>
          )}
          {/* `terminal &&` only narrows the type; `can.workdir` already implies it. */}
          {can.workdir && terminal && (
            <button className="cr-cardmenu-item" onClick={go('workdir')}>
              WORKDIR <span className="cr-cardmenu-sub">{shortDir(terminal.cwd)}</span>
            </button>
          )}
        </div>
      )}

      {mode === 'rename' && <RenamePane node={node} onDone={onClose} />}
      {mode === 'role' && terminal && (
        <CheckpointPick
          terminalId={terminal.id}
          actionLabel="SAVE"
          emptyHint="No checkpoints recorded yet — roles save from a finished turn."
          onPick={async (record, name) => {
            await saveRoleFromCheckpoint({ terminalId: terminal.id, checkpoint: record, name })
            onClose()
          }}
        />
      )}
      {mode === 'fork' && terminal && (
        <CheckpointPick
          terminalId={terminal.id}
          actionLabel="FORK"
          emptyHint="No checkpoints recorded yet — forking starts from a finished turn."
          onPick={async (record) => {
            await api.forkTerminal(terminal.id, record.index)
            onClose()
          }}
        />
      )}
      {mode === 'workdir' && terminal && (
        <WorkdirPane terminal={terminal} workspace={workspace} onDone={onClose} />
      )}
    </div>
  )

  function shortDir(dir: string): string {
    const parts = dir.split('/').filter(Boolean)
    return parts.length <= 2 ? dir : `…/${parts.slice(-2).join('/')}`
  }
}

/** Inline rename: Enter or SAVE commits, Escape backs out to the root. */
function RenamePane({ node, onDone }: { node: CanvasNode; onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState(node.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed || busy || trimmed === node.name) {
      if (trimmed === node.name) onDone()
      return
    }
    setBusy(true)
    // Notes derive their name from content unless the user pins one — a
    // rename IS a pin, so it must land on customName too or the next
    // content edit silently renames the card back (store.writeNote).
    const patch =
      node.kind === 'note'
        ? { name: trimmed, customName: (node as NoteNodeData).customName ?? trimmed }
        : { name: trimmed }
    void cookrew()
      .updateNode(node.id, patch)
      .then(() => onDone())
      .catch((e: unknown) => {
        setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  return (
    <div className="cr-cardmenu-pane">
      <input
        className="tf-input"
        value={name}
        autoFocus
        aria-label="Card name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          e.stopPropagation()
        }}
      />
      <button className="cr-btn sm" disabled={busy || !name.trim()} onClick={submit}>
        {busy ? '…' : 'SAVE'}
      </button>
      {error && (
        <div className="cr-cardmenu-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Shared checkpoint picker behind SAVE ROLE and FORK: the turn list comes
 * up newest-first, tapping a row arms it, and the confirm row carries the
 * action (role picks ask for a name, forks fire straight away).
 */
function CheckpointPick({
  terminalId,
  actionLabel,
  emptyHint,
  onPick
}: {
  terminalId: string
  actionLabel: string
  emptyHint: string
  /** Receives the chosen record; role saves also get the typed name. */
  onPick: (record: TurnRecord, name: string) => Promise<void>
}): React.JSX.Element {
  const needsName = actionLabel === 'SAVE'
  const [turns, setTurns] = useState<TurnRecord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picked, setPicked] = useState<TurnRecord | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    cookrew()
      .listTurns(terminalId)
      .then((list) => {
        if (live) setTurns([...list].reverse())
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [terminalId])

  const confirm = (): void => {
    if (!picked || busy || (needsName && !name.trim())) return
    setBusy(true)
    void onPick(picked, name.trim()).catch((e: unknown) => {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  if (loadError) return <div className="cr-cardmenu-hint">{loadError}</div>
  if (turns === null) return <div className="cr-cardmenu-hint">Loading checkpoints…</div>
  if (turns.length === 0) return <div className="cr-cardmenu-hint">{emptyHint}</div>

  return (
    <div className="cr-cardmenu-pane col">
      <div className="cr-cardmenu-ckpts">
        {turns.map((t) => (
          <button
            key={t.index}
            className={`cr-cardmenu-ckpt${picked?.index === t.index ? ' armed' : ''}`}
            onClick={() => setPicked(picked?.index === t.index ? null : t)}
          >
            <span className="cr-cardmenu-ckpt-id">T{t.index}</span>
            <span className="cr-cardmenu-ckpt-prompt">{t.prompt || '(no prompt)'}</span>
          </button>
        ))}
      </div>
      {picked && (
        <div className="cr-cardmenu-pane">
          {needsName && (
            <input
              className="tf-input"
              placeholder="role name"
              value={name}
              autoFocus
              aria-label="Role name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm()
                e.stopPropagation()
              }}
            />
          )}
          <button
            className="cr-btn sm"
            disabled={busy || (needsName && !name.trim())}
            onClick={confirm}
          >
            {busy ? '…' : actionLabel}
          </button>
        </div>
      )}
      {error && (
        <div className="cr-cardmenu-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Workdir switcher: the workspace's dirs plus a browse escape hatch. A
 * browsed directory JOINS the workspace on the way through (the backend
 * enrols it), so the picker is a real escape hatch and not a chooser that
 * throws on everything outside the list. The agent respawns there carrying
 * its conversation, so checkpoints and transcript survive the move.
 */
function WorkdirPane({
  terminal,
  workspace,
  onDone
}: {
  terminal: TerminalNodeData
  workspace: WorkspaceState
  onDone: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const api = cookrew()
  // pickDir resolves null everywhere off the desktop bridge (the remote and
  // demo stubs), so BROWSE is bridge-only by mode, not by stub probing.
  const canBrowse = !isRemoteMode() && !isDemoMode()

  /** Resolve a directory, then dispatch the move. One busy latch for both
   *  entries, so a cancelled browse can never leave the pane stuck. */
  const run = (pick: () => Promise<string | null>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void pick()
      .then((dir) => {
        if (!dir) return void setBusy(false) // browse cancelled
        if (dir === terminal.cwd) return void onDone() // already there
        return api.setTerminalCwd(terminal.id, dir).then(() => onDone())
      })
      .catch((e: unknown) => {
        setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
      })
  }

  const move = (dir: string): void => run(() => Promise.resolve(dir))
  const browse = (): void => {
    if (canBrowse) run(() => api.pickDir())
  }

  return (
    <div className="cr-cardmenu-pane col">
      <div className="cr-cardmenu-hint">
        Moving respawns the agent in the new directory, with its session and
        checkpoints intact.
      </div>
      <div className="cr-cardmenu-ckpts">
        {workspace.dirs.map((dir) => (
          <button
            key={dir}
            className={`cr-cardmenu-ckpt${dir === terminal.cwd ? ' current' : ''}`}
            disabled={busy || dir === terminal.cwd}
            onClick={() => move(dir)}
          >
            <span className="cr-cardmenu-ckpt-id">
              {dir === terminal.cwd ? '●' : dir === workspace.dirs[0] ? '◆' : ' '}
            </span>
            <span className="cr-cardmenu-ckpt-prompt">{dir}</span>
          </button>
        ))}
        {canBrowse && (
          <button className="cr-cardmenu-ckpt" disabled={busy} onClick={browse}>
            <span className="cr-cardmenu-ckpt-id">+</span>
            <span className="cr-cardmenu-ckpt-prompt">Browse…</span>
          </button>
        )}
      </div>
      {busy && <div className="cr-cardmenu-hint">Respawning…</div>}
      {error && (
        <div className="cr-cardmenu-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
