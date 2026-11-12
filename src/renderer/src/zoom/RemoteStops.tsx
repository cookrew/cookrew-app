import { InkAvatar } from './InkAvatar'
import { WorkspaceTile } from './WorkspaceTile'
import { remoteAgentView, tileView, type RemoteCard, type RemoteTile } from './remote-machine'

/**
 * THE OTHER MACHINE'S FIRST TWO STOPS (RemoteMachineView.tsx): its workspaces,
 * as the zoom's own tiles, and one workspace's whole crew, a face each. A new
 * agent there is started from the bar's box (prompt/RemotePrompt.tsx).
 */

/** A tile's refs go nowhere: the painter does not draw these. */
const NO_BIND = (): ((el: HTMLElement | null) => void) => () => undefined

export function RemoteWorkspaces({ machine, tiles, onOpen }: { machine?: string; tiles: readonly RemoteTile[]; onOpen: (tile: RemoteTile) => void }): React.JSX.Element {
  if (tiles.length === 0) return <p className="rm-empty">No workspaces here.</p>
  // As this machine's workspaces stop draws its own: its name and count over the tiles, the grid in the middle.
  return (
    <div className="rm-ws-stop">
      <div className="rm-ws-block" style={{ ['--rm-cols' as string]: Math.min(tiles.length, 3) }}>
      {machine && (
        <div className="rm-ws-title">
          <b>{machine}</b>
          <span>{tiles.length} {tiles.length === 1 ? 'workspace' : 'workspaces'}</span>
        </div>
      )}
    <div className="rm-tiles">
      {tiles.map((tile) => (
        <div key={tile.id} className="rm-cell" data-front={tile.active || undefined} title={tile.active ? `In front on that machine` : undefined}>
          <div className="rm-tile-at">
            <WorkspaceTile mark={tileView(tile)} bind={NO_BIND} onOpen={() => onOpen(tile)} />
          </div>
        </div>
      ))}
    </div>
    </div>
    </div>
  )
}

export function RemoteCrew({ cards, onOpen }: { cards: readonly RemoteCard[]; onOpen: (card: RemoteCard) => void }): React.JSX.Element {
  if (cards.length === 0) return <p className="rm-empty">No agents here yet.</p>
  return (
    <div className="rm-crew">
      {cards.map((card) => {
        const view = remoteAgentView(card)
        return (
          <button key={card.id} type="button" className="rm-face" aria-label={`Open ${card.name}, ${card.word}`} onClick={() => onOpen(card)}>
            <InkAvatar id={card.id} preset={card.preset} orch={card.orch} status={view.status} weight="regular" />
            <b>{card.name}</b>
            <span className={`zv-st ${view.status}`}>{card.word}</span>
          </button>
        )
      })}
    </div>
  )
}
