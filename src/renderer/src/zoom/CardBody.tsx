import { useEffect, useRef, useState } from 'react'
import { CardWords } from './quick-reply'
import type { AgentView } from './zoom-model'

/**
 * THE CARD READS ITS LATEST REPLY (owner, 2026-11-04): a card said one line of
 * a message and left the rest to the full view, so an agent's answer could not
 * be read where it is answered. Now the words wrap into the room the card has,
 * and when they are cut a tap on them unfolds the message in place: it covers
 * the strip of thumbnails and scrolls under a finger or a wheel, with the reply
 * box still under it. Another tap, or `less`, folds it. The card round the
 * words keeps its tap into the full view; words that fit leave theirs to it.
 *
 * Both cards draw this (ZoomParts · AgentNode, AgentCard.tsx). The zoom painter
 * owns this frame's transform and opacity through `frameRef`; the classes here
 * are all that React writes.
 */

/** A fold belongs to the words it was opened on; null where there is nothing to unfold. */
export function wordsOf(agent: AgentView, sent: string | null): string | null {
  const latest = agent.turn?.latest
  if (sent !== null || !latest || latest.tone === 'working') return null
  return latest.full ?? latest.text
}

export function CardBody({
  agent,
  sent,
  roomy,
  className = 'zv-body',
  style,
  frameRef
}: {
  agent: AgentView
  /** The reply just sent, which the words give way to for a moment. */
  sent: string | null
  /** The card has no thumbnails, so their strip is the words' room. */
  roomy: boolean
  className?: string
  style?: React.CSSProperties
  frameRef?: (el: HTMLElement | null) => void
}): React.JSX.Element {
  const words = wordsOf(agent, sent)
  const box = useRef<HTMLDivElement>(null)
  const [openOn, setOpenOn] = useState<string | null>(null)
  const [cut, setCut] = useState(false)
  const open = words !== null && openOn === words

  // Cut is a measure of the laid-out words, so it is taken again when their
  // size moves too: a phone's type follows the camera (scene-words.ts).
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const measure = (): void => setCut(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (!open) el.scrollTop = 0
    if (typeof ResizeObserver === 'undefined') return undefined
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    if (el.firstElementChild) watch.observe(el.firstElementChild)
    return () => watch.disconnect()
  }, [words, sent, open, roomy])

  const unfoldable = words !== null && (cut || open)
  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    // A drag that selected words to copy them is not a tap.
    if (!unfoldable || window.getSelection()?.isCollapsed === false) return
    setOpenOn(open ? null : words)
  }
  const hold = (e: React.PointerEvent): void => {
    if (unfoldable) e.stopPropagation()
  }

  return (
    <div ref={frameRef} className={`${className}${roomy ? ' roomy' : ''}${open ? ' open' : ''}${unfoldable ? ' more' : ''}`} style={style}>
      <div ref={box} className="zv-words" onClick={toggle} onPointerDown={hold}>
        <CardWords agent={agent} sent={sent} />
      </div>
      {unfoldable && (
        <button type="button" className="zv-more" aria-expanded={open} aria-label={open ? 'Show less of the reply' : 'Show the whole reply'} onClick={toggle} onPointerDown={hold}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}
