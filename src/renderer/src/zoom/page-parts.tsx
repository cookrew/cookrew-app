import { memo } from 'react'
import { useThumb } from '../activity-thumb-store'
import { sameProps } from './same-props'
import type { ItemView } from './zoom-model'

/**
 * THE SMALL PARTS A WORKSPACE TILE DRAWS (WorkspaceTile.tsx): a browser's or a
 * note's page and the counts beside it. Apart from ZoomParts.tsx because a
 * tile is drawn where no card is (the console's Devices level, DevicesCanvas.tsx),
 * and a card's parts bring the app's calls with them (CardBody, quick-reply):
 * the console's first load must not (tests/console-first-load.test.ts).
 */

/** How a part hands its element to the painter. */

export type Bind = (key: string) => (el: HTMLElement | null) => void

export const PAGE_GLYPH = (
  <svg className="zv-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1.5" width="10" height="9" rx="1.2" />
    <path d="M1 4h10" />
  </svg>
)
export const NOTE_GLYPH = (
  <svg className="zv-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 1h5.5L10 3.5V11H2z" />
    <path d="M7.5 1v2.5H10M4 6h4M4 8h3" />
  </svg>
)

/**
 * "▭ 2 ▤ 1": browsers and notes, zero counts left out. When both are, `none`
 * if one is given, else nothing: under an agent's face "nothing open" was
 * noise (owner, 2026-11-01).
 */
export const Counts = memo(function Counts({ browsers, notes, none }: { browsers: number; notes: number; none?: string }): React.JSX.Element | null {
  if (browsers + notes === 0) return none ? <span className="zv-none">{none}</span> : null
  return (
    <>
      {browsers > 0 && (
        <span title={`${browsers} browser${browsers === 1 ? '' : 's'}`}>
          {PAGE_GLYPH}
          {browsers}
        </span>
      )}
      {notes > 0 && (
        <span title={`${notes} note${notes === 1 ? '' : 's'}`}>
          {NOTE_GLYPH}
          {notes}
        </span>
      )}
    </>
  )
}, sameProps)

/**
 * A browser's picture: the live thumbnail when there is one, else a drawn page in its tint.
 * `words={false}`: the page without its address or a note's lines, for a face
 * too small to set them legibly (the side group's column, UI/UX QA 2026-11-01:
 * "file://age..." at about 6px). Its name is the face's own tag.
 */
export const Page = memo(function Page({ item, big = false, words = true }: { item: ItemView; big?: boolean; words?: boolean }): React.JSX.Element {
  const thumb = useThumb(item.id)
  if (item.kind === 'note') {
    return (
      <div className="zv-nt">
        {big && NOTE_GLYPH}
        {words && <b>{item.title}</b>}
        {words && <span>{item.line || 'empty note'}</span>}
        <i />
        <i />
      </div>
    )
  }
  return (
    <>
      <div className="zv-bar">
        {big && (
          <i className="zv-fav" style={{ background: item.tint }}>
            {item.initial}
          </i>
        )}
        {words && item.host}
      </div>
      {thumb ? (
        <img className="zv-shot" src={thumb} alt="" draggable={false} />
      ) : (
        <div className="zv-pg">
          <b style={{ background: item.tint }} />
          <i />
          <i />
        </div>
      )}
    </>
  )
}, sameProps)
