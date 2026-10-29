// The middle when a browser or note is picked on the left: the item itself,
// full size — the same note view and the same browser page the terminal's
// lower half shows (AttachPanel), hosted by the stage instead of a terminal.
import { useEffect, useRef } from 'react'
import { AttachPanel } from '../AttachPanel'
import { attachView, useAttachView } from '../attach-view'
import type { StageItemCard } from './stage-select'

/** The attach-view host id of the stage's own item: no terminal has it. */
export const STAGE_HOST = 'stage'
const NO_RECT = { x: 0, y: 0, width: 0, height: 0 }

export function StageItemPane({ item, onClose }: { item: StageItemCard; onClose: () => void }): React.JSX.Element {
  const view = useAttachView()
  useEffect(() => {
    attachView.open(STAGE_HOST, item.id, item.kind)
    return () => attachView.close(STAGE_HOST)
  }, [item.id, item.kind])
  // Closed from inside (the browser's own ✕): the stage goes back to following.
  const mine = view !== null && view.terminalId === STAGE_HOST && view.itemId === item.id
  const shown = useRef(false)
  useEffect(() => {
    if (mine) shown.current = true
    else if (shown.current) onClose()
  }, [mine, onClose])
  return (
    <div className="stg-item-pane">
      {mine && view && <AttachPanel item={item.attachment} view={view} cardRect={NO_RECT} />}
    </div>
  )
}
