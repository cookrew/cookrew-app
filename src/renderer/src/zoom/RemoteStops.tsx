import { useState } from 'react'
import { InkAvatar } from './InkAvatar'
import { WorkspaceTile } from './WorkspaceTile'
import { remoteAgentView, sendRefusal, tileView, type RemoteCard, type RemoteTile } from './remote-machine'
import { remoteDraft, setRemoteDraft, type RemoteMachineRef } from './remote-machine-store'
import { callRemote } from './use-remote-machine'

/**
 * THE OTHER MACHINE'S FIRST TWO STOPS (RemoteMachineView.tsx): its workspaces,
 * as the zoom's own tiles, and one workspace's whole crew, a face each, with
 * the box that starts a new agent there.
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

/** A new agent, started on the other machine in this workspace (watch-routes.ts · /api/watch/new with the seat). */
export function RemoteNewAgent({ machine, workspaceId, onStarted }: { machine: RemoteMachineRef; workspaceId: string; onStarted: () => void }): React.JSX.Element {
  const box = `new:${workspaceId}`
  const [words, setWords] = useState(() => remoteDraft(machine.id, box))
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const write = (text: string): void => {
    setWords(text)
    setRemoteDraft(machine.id, box, text)
  }
  const start = async (): Promise<void> => {
    const text = words.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const answer = await callRemote(machine.id, 'POST', `api/watch/new?seat=${encodeURIComponent(workspaceId)}`, { text })
      const refusal = sendRefusal(answer, machine.name)
      if (refusal) return setNote({ text: refusal, failed: true })
      write('')
      setNote({ text: `Started on ${machine.name}.`, failed: false })
      onStarted()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rm-new">
      <form className="rm-box" onSubmit={(e) => { e.preventDefault(); void start() }}>
        <input value={words} onChange={(e) => write(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder={`Start a new agent on ${machine.name}…`} aria-label={`Start a new agent on ${machine.name}`} autoComplete="off" />
        <button type="submit" disabled={busy || !words.trim()}>Start</button>
      </form>
      <p className={`rm-note${note?.failed ? ' failed' : ''}`} role="status">{note?.text ?? ''}</p>
    </div>
  )
}
