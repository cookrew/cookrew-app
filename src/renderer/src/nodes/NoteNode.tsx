import { useEffect, useRef, useState } from 'react'
import { NodeProps, NodeResizer } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import { marked } from 'marked'
import type { NoteNodeData } from '../../../shared/model'
import { cookrew } from '../api'
import { useCanvasUi } from '../canvas-ui'

export function NoteNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: NoteNodeData }).node
  const { tool, zoomToNode } = useCanvasUi()
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
    if (tool !== 'select') return
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

  return (
    <div className={`node note-node${selected ? ' selected' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={180} minHeight={120} />
      <NodeHandles />
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
            __html: marked.parse(node.content || '*Double-click to write…*') as string
          }}
        />
      )}
    </div>
  )
}
