import { memo, useId } from 'react'
import { brushPathCached, CORNER, harnessMark, type MarkName } from './ink-marks'
import { cornerOf, type CornerMark, type InkStatus } from './ink-status'

/**
 * An agent drawn in ink: its harness mark inside an ensō, open, or closed for
 * an orchestrator (ink-marks.ts). Paths are computed once per mark and kept.
 * Drawn plain: a rough-edge filter over every stroke costs a raster pass per
 * agent, and at a dozen agents on screen it is the frame, not the flourish.
 *
 * Its status (ink-status.ts) is a second brush in red over the same ink:
 * working laps a third of a turn along the ensō, waiting closes the ring and
 * blinks it with the harness mark (also red), done ticks the shoulder, and
 * offline fades the ink and writes a z there. The motion is CSS (zoom.css):
 * a rotation and an opacity, nothing that rebuilds a path per frame; idle,
 * done and offline stand still.
 */
const GLYPH = 'translate(14.5 15) scale(0.71)'

function Stroke({ name, width, seed, dry, transform, className }: { name: MarkName; width: number; seed: number; dry?: number; transform?: string; className?: string }): React.JSX.Element {
  const p = brushPathCached(name, dry === undefined ? { width, seed } : { width, seed, dry })
  return (
    <g className={className ? `ink-stroke ${className}` : 'ink-stroke'} transform={transform}>
      <path className="ink-bleed" d={p.body} />
      <path className="ink-body" d={p.body} />
      <circle className="ink-body" cx={p.drop.x} cy={p.drop.y} r={p.drop.r} />
      <path className="ink-bristle" d={p.bristles} />
    </g>
  )
}

/** A steady small seed per agent, so two agents on one harness are not identical brushstrokes. */
const seedOf = (id: string): number => {
  let h = 7
  for (let i = 0; i < id.length; i++) h = (h * 17 + id.charCodeAt(i)) % 23
  return 5 + h
}

/**
 * How heavy the status brush is for the size the face is drawn at: the
 * smaller the face, the fatter the red has to be to be seen. A mini face
 * (14 px) drops the harness mark and keeps the ensō and its status.
 */
export type InkWeight = 'large' | 'regular' | 'small' | 'mini'
const WEIGHT: Record<InkWeight, number> = { large: 1, regular: 1.2, small: 1.45, mini: 1.9 }
/** The red's width on the ensō before the weight; the ensō itself is 4.6. */
const RIDE = 5.6
const CORNER_WIDTH: Record<CornerMark, number> = { tick: 7, zee: 4.3 }
const CORNER_DRY: Record<CornerMark, number> = { tick: 0.28, zee: 0.12 }
/** Scales a corner mark about its own place, so it grows outward from the shoulder. */
const cornerAt = (k: number): string => `translate(${CORNER.x} ${CORNER.y}) scale(${k}) translate(${-CORNER.x} ${-CORNER.y})`

export const InkAvatar = memo(function InkAvatar({
  id,
  preset,
  orch = false,
  size,
  status = 'idle',
  weight = 'regular',
  className
}: {
  id: string
  preset: string
  orch?: boolean
  size?: number
  status?: InkStatus
  weight?: InkWeight
  className?: string
}): React.JSX.Element {
  const seed = seedOf(id)
  const mini = weight === 'mini'
  const k = WEIGHT[weight]
  const corner = cornerOf(status)
  // The ensō steps aside round a corner mark: a cut, so it works on any background.
  const cutId = `ink-cut-${useId().replace(/:/g, '')}`
  const cornerPaths = corner ? brushPathCached(corner, { width: CORNER_WIDTH[corner], seed, dry: CORNER_DRY[corner] }) : null
  return (
    <svg className={`ink-avatar ${status}${className ? ` ${className}` : ''}`} viewBox="-4 -4 108 108" width={size} height={size} aria-hidden="true">
      {cornerPaths && (
        <defs>
          <mask id={cutId} maskUnits="userSpaceOnUse" x="-30" y="-30" width="170" height="170">
            <rect x="-30" y="-30" width="170" height="170" fill="#fff" />
            <path d={cornerPaths.body} transform={cornerAt(k)} fill="#000" stroke="#000" strokeWidth="7" strokeLinejoin="round" />
          </mask>
        </defs>
      )}
      <g className="ink-own">
        <g mask={cornerPaths ? `url(#${cutId})` : undefined}>
          <Stroke name={orch ? 'ensoClosed' : 'enso'} width={mini ? 8.5 : 4.6} seed={seed} />
        </g>
        {!mini && <Stroke name={harnessMark(preset)} width={6.2} seed={seed} transform={GLYPH} className="ink-glyph" />}
      </g>
      {status === 'working' && (
        <g className="ink-zhu ink-lap">
          {/* unpainted: centres the group's box on the ensō, so the lap turns about it */}
          <circle cx="50" cy="50.5" r="62" fill="none" stroke="none" />
          <Stroke name="ringWorking" width={RIDE * 1.08 * k} seed={seed} dry={0.42} />
        </g>
      )}
      {status === 'waiting' && (
        <g className="ink-zhu">
          <Stroke name="ringWaiting" width={RIDE * 1.22 * k} seed={seed} dry={0.08} />
        </g>
      )}
      {corner && <Stroke name={corner} width={CORNER_WIDTH[corner]} seed={seed} dry={CORNER_DRY[corner]} transform={cornerAt(k)} className={status === 'done' ? 'ink-corner ink-zhu' : 'ink-corner'} />}
    </svg>
  )
})

/** A ring alone: a workspace's seal ring, or an empty mark. */
export const InkRing = memo(function InkRing({ seed = 4, width = 3.2 }: { seed?: number; width?: number }): React.JSX.Element {
  return (
    <svg className="ink-ring" viewBox="-4 -4 108 108" aria-hidden="true">
      <Stroke name="ensoClosed" width={width} seed={seed} />
    </svg>
  )
})

/** An ink tie, stretched by its holder's transform. */
export const InkTie = memo(function InkTie(): React.JSX.Element {
  return (
    <svg className="ink-tie" viewBox="0 40 100 20" preserveAspectRatio="none" aria-hidden="true">
      <Stroke name="tie" width={4.2} seed={7} />
    </svg>
  )
})
