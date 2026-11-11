import { Fragment, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { ENTRY_MS, entryFrom } from './remote-entry'
import { crumbsOf } from './remote-machine'
import { remotePlace, type RemotePlace } from './remote-machine-store'
import { RemoteCardView } from './RemoteCardView'
import { RemoteItemView } from './RemoteItemView'
import { RemoteCrew, RemoteNewAgent, RemoteWorkspaces } from './RemoteStops'
import { useRemoteCards } from './use-remote-machine'
import './remote-machine.css'

/**
 * ANOTHER MACHINE, INSIDE THIS ONE'S ZOOM VIEW (owner 2026-11-10, design B).
 *
 * Entered in place from its frame on the devices stop (ZoomView · MachineNode;
 * the view opens out of that frame, remote-entry.ts): its
 * workspaces, one workspace's crew, an agent's card, one of that agent's
 * browsers, screens or notes. The breadcrumb always says whose they are, in
 * the machine's colour, and "Devices" leaves it. What is on show is read
 * again every few seconds; a machine that stops answering keeps its last stop
 * on screen, greyed, and every box keeps its words (remote-machine-store.ts).
 */

const read = (): RemotePlace => remotePlace.get()

export function RemoteMachineView(): React.JSX.Element | null {
  const place = useSyncExternalStore(remotePlace.subscribe, read, read)
  const machine = place.machine
  const { cards, answering, refresh } = useRemoteCards(machine?.id ?? null, place.workspace?.id ?? null)
  const stage = useRef<HTMLElement | null>(null)
  // ENTERED IN PLACE: the view opens out of the machine's own frame on the devices stop, from
  // where that frame stands. Once per machine entered, and not at all for someone who asked the
  // system for less motion.
  const enteredId = machine?.id ?? null
  const from = machine?.from
  useLayoutEffect(() => {
    const el = stage.current
    if (!el || !from || typeof el.animate !== 'function') return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const box = el.getBoundingClientRect()
    const first = entryFrom(from, { x: box.left, y: box.top, w: box.width, h: box.height })
    if (first === null) return
    el.animate([{ clipPath: first.from, opacity: 0.6 }, { clipPath: first.to, opacity: 1 }], { duration: ENTRY_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' })
    // `from` is where the frame stood at the moment of entry: read once, with the machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enteredId])
  if (!machine) return null

  const card = place.agent ? (cards?.cards.find((one) => one.id === place.agent?.id) ?? null) : null
  const item = place.item && card ? (card.items.find((one) => one.id === place.item?.id) ?? null) : null
  const crumbs = crumbsOf(machine, place.workspace, place.agent, place.item)
  const last = crumbs.length - 1

  const stop = (): React.ReactNode => {
    if (!cards) return <p className="rm-empty">{answering ? `Asking ${machine.name}…` : `${machine.name} isn’t answering.`}</p>
    if (!place.workspace) return <RemoteWorkspaces tiles={cards.workspaces} onOpen={(tile) => remotePlace.workspace({ id: tile.id, name: tile.name })} />
    if (!place.agent) {
      return (
        <>
          <RemoteNewAgent machine={machine} workspaceId={place.workspace.id} onStarted={refresh} />
          <RemoteCrew cards={cards.cards} onOpen={(one) => remotePlace.agent({ id: one.id, name: one.name })} />
        </>
      )
    }
    if (!card) return <p className="rm-empty">{place.agent.name} is no longer in this workspace on {machine.name}.</p>
    if (place.item) {
      return item ? <RemoteItemView machine={machine} item={item} workspaceId={place.workspace.id} /> : <p className="rm-empty">{place.item.title} is no longer on {card.name}’s card.</p>
    }
    return <RemoteCardView key={card.id} machine={machine} card={card} onSent={refresh} onItem={(one) => remotePlace.item({ id: one.id, title: one.title, kind: one.kind })} />
  }

  return (
    <section ref={stage} className="rm-stage" aria-label={`${machine.name}, another machine of your account`}>
      <nav className="rm-bar" aria-label="Where you are">
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.depth}>
            {i > 0 && <span className="rm-sep" aria-hidden="true">›</span>}
            <button
              type="button"
              className={`rm-crumb${crumb.remote ? ' remote' : ''}`}
              aria-current={i === last ? 'location' : undefined}
              onClick={() => (i === last ? undefined : remotePlace.backTo(crumb.depth))}
            >
              {crumb.label}
            </button>
          </Fragment>
        ))}
        <span className="rm-on">on {machine.name}</span>
      </nav>
      {!answering && <p className="rm-quiet" role="status">{machine.name} isn’t answering. This is what it showed last; nothing you typed is lost.</p>}
      <div className="rm-body" data-stale={!answering || undefined}>
        {stop()}
      </div>
    </section>
  )
}
