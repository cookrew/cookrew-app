import { CrIcon } from './icons'
import type { NoteNodeData } from '../../shared/model'

/**
 * One note on the board. DATA CONTRACT: binds the same source its canvas
 * card (NoteNode) renders — `node.content` from the live workspace state —
 * so the board never shows a staler note than the canvas. The body is the
 * note's CONTEXT: its opening lines, clamped, in place of an agent's turn.
 */
export function NoteRow({
  node,
  workspaceName,
  selected,
  selectable = false,
  onOpen
}: {
  node: NoteNodeData
  workspaceName: string
  selected: boolean
  /** Edit mode: the row ticks instead of handing off to the canvas. */
  selectable?: boolean
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`ags-row ags-element${selected ? ' selected' : ''}${selectable ? ' selectable' : ''}`}
      aria-pressed={selectable ? selected : undefined}
      role="button"
      tabIndex={0}
      title={node.name}
      onClick={() => onOpen(node.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(node.id)
        }
      }}
    >
      {selectable && (
        <span className={`ags-tick${selected ? ' on' : ''}`} aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      )}
      <span className="ags-avatar ags-el-tile note">
        <CrIcon name="note" />
      </span>
      <span className="ags-body">
        <span className="ags-nameline">
          <span className="ags-name">{node.name}</span>
          <span className="cr-chip">NOTE</span>
          {node.locked && <span className="cr-chip">LOCKED</span>}
          <span className="cr-chip violet">{workspaceName}</span>
        </span>
        <span className="ags-note-context">{noteExcerpt(node.content)}</span>
      </span>
    </div>
  )
}

/** Opening lines of the note, plain — enough context to know which one. */
function noteExcerpt(content: string): string {
  const lines = content
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter((l) => l.length > 0)
  return lines.slice(0, 3).join(' · ').slice(0, 240) || 'Empty note'
}
