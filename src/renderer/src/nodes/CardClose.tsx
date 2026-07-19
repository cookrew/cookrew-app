import { cookrew } from '../api'

/**
 * ✕ in a card header: removes the node from the canvas — for terminals that
 * also kills the session (same as ⌘W on a selected card).
 */
export function CardClose({ nodeId, dark }: { nodeId: string; dark?: boolean }): React.JSX.Element {
  return (
    <button
      className={`card-close${dark ? ' dark' : ''} nodrag`}
      title="Close card"
      onClick={(e) => {
        e.stopPropagation()
        void cookrew().removeNode(nodeId)
      }}
    >
      ✕
    </button>
  )
}
