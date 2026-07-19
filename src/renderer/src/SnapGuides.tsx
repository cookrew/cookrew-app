import { ViewportPortal, useStore } from '@xyflow/react'
import type { SnapGuide } from './card-snap'

/**
 * Alignment guide lines shown while a card resize or drag is snapped flush
 * to a neighbouring window's edge. Rendered in flow coordinates via
 * ViewportPortal; thickness is divided by zoom so the line stays hairline
 * on screen at any zoom level.
 */
export function SnapGuides({ guides }: { guides: SnapGuide[] }): React.JSX.Element | null {
  const zoom = useStore((s) => s.transform[2])
  if (guides.length === 0) return null
  const thickness = 1.5 / zoom
  const overshoot = 12 / zoom
  return (
    <ViewportPortal>
      {guides.map((guide) => (
        <div
          key={`${guide.axis}-${guide.at}`}
          className="cr-snap-guide"
          style={
            guide.axis === 'x'
              ? {
                  left: guide.at - thickness / 2,
                  top: guide.from - overshoot,
                  width: thickness,
                  height: guide.to - guide.from + overshoot * 2
                }
              : {
                  left: guide.from - overshoot,
                  top: guide.at - thickness / 2,
                  width: guide.to - guide.from + overshoot * 2,
                  height: thickness
                }
          }
        />
      ))}
    </ViewportPortal>
  )
}
