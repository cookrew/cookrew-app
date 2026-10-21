// One FigureArt drawn into a rect. The art is a self-contained, escaped SVG
// string from the kit; same art → same element, so nothing redraws per frame.
import { memo, type CSSProperties } from 'react'
import type { FigureArt, Rect } from '../../shared/strata'

export const rectStyle = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h })

export const Figure = memo(function Figure({ art, rect, className }: { art: FigureArt; rect?: Rect; className?: string }) {
  return (
    <div
      className={`fig${className ? ` ${className}` : ''}`}
      style={rect ? rectStyle(rect) : undefined}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: art.svg }}
    />
  )
})
