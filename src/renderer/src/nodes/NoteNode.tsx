import { useEffect, useRef, useState } from 'react'
import { NodeProps, NodeResizer, useStore } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import { CardPick } from './CardPick'
import { renderNoteMarkdown } from '../note-markdown'
import { cardTypeScale, cardZoomMode } from './card-zoom'
import type { NoteNodeData } from '../../../shared/model'
import { cookrew } from '../api'
import { useCanvasUi } from '../canvas-ui'

export function NoteNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: NoteNodeData }).node
  const { tool, clipping, zoomToNode, picked, togglePick } = useCanvasUi()
  // Quantized zoom bucket — only flips crossing MINI_ZOOM.
  const mode = useStore((s) => cardZoomMode(s.transform[2]))
  // The mini tile's title must survive the zoom that produced it. Type here is
  // a flat 10px (.node-title), so at a 0.2 canvas it renders at two physical
  // pixels — a tile whose whole job is to say WHICH note this is, saying
  // nothing. The terminal tile has always counter-scaled; notes never did.
  const invZoom = useStore((s) => cardTypeScale(s.transform[2]))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.content)
  // Single click zooms the note to the stage after a beat; a double click
  // (edit) cancels the pending zoom so editing stays in place.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!editing) setDraft(node.content)
  }, [node.content, editing])

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
    }
  }, [])

  const onBodyClick = (): void => {
    // Clipping: the whole card is a bigger checkbox — no zoom.
    if (clipping) {
      togglePick(node.id)
      return
    }
    if (tool !== 'move') return
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      zoomToNode(node.id)
    }, 220)
  }

  const onBodyDoubleClick = (): void => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    if (!node.locked) setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    if (draft !== node.content) {
      void cookrew().updateNode(node.id, { content: draft })
    }
  }

  // Zoomed OUT: a minimal tile — title only, NO rendered markdown. A note's
  // content is a full design doc, and mounting 28 of those markdown DOM trees at
  // the fit-to-view overview is what OOMs a phone. The body renders only once a
  // note is big enough to read (card zoom); a tap zooms in to it. This mirrors
  // TerminalNode's mini path.
  if (mode === 'mini') {
    return (
      <div
        className={`node note-node mini${selected ? ' selected' : ''}${clipping && picked.has(node.id) ? ' picked' : ''}`}
        style={{ ['--z' as string]: String(invZoom) }}
        onClick={onBodyClick}
      >
        <NodeHandles />
        <CardPick id={node.id} />
        {/* The TILE grammar, not a shrunken card: one centred row of glyph +
            name, the way a terminal tile reads. The header bar and the empty
            body below it were card chrome rendered at a size nobody can use —
            a 2px rule and a note-coloured void that said nothing about which
            note this was. */}
        <div className="node-mini">
          <span className="node-title">{node.name}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`node note-node${selected ? ' selected' : ''}${clipping && picked.has(node.id) ? ' picked' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={180} minHeight={120} />
      <NodeHandles />
      <CardPick id={node.id} />
      <div className="node-header note-header">
        <span className="node-title">{node.name}</span>
        {node.locked && <span className="lock-badge">locked</span>}
        <CardClose nodeId={node.id} />
      </div>
      {editing ? (
        <textarea
          className="note-editor nodrag nowheel"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') commit()
            e.stopPropagation()
          }}
        />
      ) : (
        <div
          className="note-body nodrag nowheel"
          onClick={onBodyClick}
          onDoubleClick={onBodyDoubleClick}
          dangerouslySetInnerHTML={{
            // Markdown only — a note's own `<div class="cr-ckpt-…">` diagram is
            // text, not app DOM. See note-markdown.ts.
            __html: renderNoteMarkdown(node.content || '*Double-click to write…*')
          }}
        />
      )}
    </div>
  )
}
