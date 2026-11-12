import { memo } from 'react'
import { InkAvatar } from './InkAvatar'
import { Counts, Page, type Bind } from './page-parts'
import { sameProps } from './same-props'
import { DECK_POSE, fanOf } from './zoom-layout'
import type { ItemView, MarkView } from './zoom-model'
import './workspace-tile.css'

/**
 * A WORKSPACE'S TILE (owner, 2026-11-04: "how the agents group and the
 * artifacts group show on one page"). One bench, one name, two groups, each
 * its own door: the agents' faces open the crew, the artifacts' deck deals out
 * the grid. The doors say what they open, so the stop needs no hint line, and
 * every word lives inside the frame, so no label can run over its neighbour's.
 *
 * Every workspace draws this, the open one too: there the faces
 * are the scene's own, standing in the tile, so the tile goes and they go on
 * opening (zoom-frame.ts). The painter draws `.zv-tw` words at one size on
 * screen (paintDeviceWords); the rest rides the camera.
 */

/** The sheets a deck stands on: its depth says how much a workspace holds, never more than the eye can count. */
const DECK_DEPTHS = [1, 2, 6, 30] as const
export const deckDepth = (total: number): number => DECK_DEPTHS.filter((n) => total >= n).length

/** A sheet's place in the deck, top first: the top one square-on, each under it a little further out. */
const sheetPose = (i: number): string => `translate(${i * 6}px, ${i * -5}px) rotate(${i === 0 ? -1.5 : i * 2.2}deg)`

const ArtifactDeck = memo(function ArtifactDeck({ items, total }: { items: readonly ItemView[]; total: number }): React.JSX.Element {
  const depth = deckDepth(total)
  const style = { transform: `translate(${DECK_POSE.x}px, ${DECK_POSE.y}px) scale(${DECK_POSE.s})` }
  if (depth === 0) return <div className="zv-deck" style={style}><div className="zv-sheet empty" /></div>
  return (
    <div className="zv-deck" style={style}>
      {Array.from({ length: depth }, (_, i) => depth - 1 - i).map((i) => {
        const item = items[i]
        return (
          <div key={i} className={`zv-sheet zv-th ${item?.kind ?? 'blank'}`} style={{ transform: sheetPose(i) }}>
            {item && <Page item={item} words={false} />}
          </div>
        )
      })}
    </div>
  )
}, sameProps)

/** What a deck draws: two rebuilds of the same things are the same deck (the model makes new objects each time, same-props.ts compares them by identity). */
const sameDeck = (a: readonly ItemView[], b: readonly ItemView[]): boolean => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.kind === b[i].kind && x.title === b[i].title && x.host === b[i].host)
type TileProps = { mark: MarkView; open?: boolean; bind: Bind; onOpen: () => void; onOpenItems?: () => void }
export const sameTile = (a: TileProps, b: TileProps): boolean =>
  sameDeck(a.mark.deck, b.mark.deck) && sameProps({ ...a, mark: { ...a.mark, deck: [] } }, { ...b, mark: { ...b.mark, deck: [] } })

/** The digits a snug tile's split has room for: past them it says the total. */
const SPLIT_DIGITS = 5

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const WorkspaceTile = memo(function WorkspaceTile({ mark, open = false, bind, onOpen, onOpenItems }: TileProps): React.JSX.Element {
  const n = mark.presets.length
  const known = mark.browsers !== null && mark.notes !== null
  const browsers = mark.browsers ?? 0
  const notes = mark.notes ?? 0
  const total = browsers + notes
  // Bottom → top, the first agent on top, as the open crew's fan (zoom-layout.ts · stackOf).
  const shown = mark.presets.slice(0, 6).reverse()
  const fan = fanOf(shown.length)
  // Nothing behind it, no door: a tap would only land on an empty grid.
  const itemsDoor = known && total > 0 && onOpenItems
  return (
    <div ref={bind(open ? 'openMark' : `mark:${mark.id}`)} className="zv-mark" data-open={open || undefined} data-waiting={mark.waitingCount > 0 || undefined}>
      <div className="zv-tile" />
      {!open && (
        <>
          {shown.map((preset, i) => (
            <div key={i} className="zv-av zv-mark-av" style={{ transform: `translate(${fan[i].x}px, ${fan[i].y}px) rotate(${fan[i].r}deg) scale(${fan[i].s})`, zIndex: i }}>
              <InkAvatar id={`${mark.id}:${i}`} preset={preset} />
            </div>
          ))}
        </>
      )}
      {known && <ArtifactDeck items={mark.deck} total={total} />}
      <button type="button" className={`zv-door agents${itemsDoor ? '' : ' whole'}`} aria-current={open ? 'true' : undefined} aria-label={`Open ${mark.name} agents, ${plural(n, 'agent')}${mark.waitingCount > 0 ? `, ${mark.waitingCount} waiting` : ''}`} title={`${mark.name} · ${plural(n, 'agent')}`} onClick={onOpen} />
      {itemsDoor && (
        <button type="button" className="zv-door items" aria-label={`Open ${mark.name} artifacts, ${plural(browsers, 'browser')}, ${plural(notes, 'note')}`} title={`${mark.name} · ${plural(browsers, 'browser')}, ${plural(notes, 'note')}`} onClick={onOpenItems} />
      )}
      <div className="zv-tw zv-tile-name">{mark.name}</div>
      {mark.waitingCount > 0 && <div className="zv-tw zv-tile-wait" title={`${mark.waitingCount} waiting`}>{mark.waitingCount}</div>}
      <div className="zv-tw zv-tile-cap agents">
        {n > 0 ? <><span className="zv-seal">{n}</span><small>{n === 1 ? 'agent' : 'agents'}</small></> : <><em>no agents</em><span className="zv-zero">0</span></>}
      </div>
      {known && (
        <div className="zv-tw zv-tile-cap items" data-long={`${browsers}${notes}`.length > SPLIT_DIGITS || undefined}>
          {total > 0 ? <><span className="zv-total">{total}</span><span className="zv-split"><Counts browsers={browsers} notes={notes} /></span></> : <><em>no artifacts</em><span className="zv-zero">0</span></>}
        </div>
      )}
    </div>
  )
}, sameTile)
