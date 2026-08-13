import { CrIcon } from '../icons'
import { useCanvasUi } from '../canvas-ui'

/**
 * ✕ in a card header. It ASKS rather than acting: this is a small target
 * sitting beside the card's other controls, and for a terminal the same click
 * ends a live session. The dialog lives at App level (see requestClose).
 */
export function CardClose({ nodeId, dark }: { nodeId: string; dark?: boolean }): React.JSX.Element {
  const { requestClose } = useCanvasUi()
  return (
    <button
      className={`card-close${dark ? ' dark' : ''} nodrag`}
      title="Close card"
      onClick={(e) => {
        e.stopPropagation()
        requestClose(nodeId)
      }}
    >
      <CrIcon name="close" />
    </button>
  )
}
