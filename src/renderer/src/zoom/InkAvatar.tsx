import { memo, useId } from 'react'
import { brushPathCached, CORNER, harnessMark, type MarkName } from './ink-marks'
import { cornerOf, type CornerMark, type InkStatus } from './ink-status'
import { HarnessLogo, isBrand } from './harness-logo'

/**
 * An agent: its harness's own logo on a light disc (owner 2026-11-13: "浅色底带点
 * 拟物，不要黑色框了"), a plain shell keeping the ink prompt (harness-logo.tsx).
 * The disc is a little object: a soft shadow under it, a warm white body lit from
 * above, a bevelled rim; an orchestrator's has a groove ring inside its rim, where
 * its ensō used to close. No filter: gradients only, so a crew of thirty costs no
 * raster pass. Paths are computed once per mark and kept.
 * Drawn plain: a rough-edge filter over every stroke costs a raster pass per
 * agent, and at a dozen agents on screen it is the frame, not the flourish.
 *
 * Its status (ink-status.ts) is a second brush in red over the same ink:
 * working laps a third of a turn along the ensō, waiting closes the ring and
 * blinks it with the harness mark (an ink prompt turns red too; a logo keeps
 * its colours and only blinks), done ticks the shoulder, and
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

/** Where the ensō stood: the status rings (ink-marks.ts · ringWorking, ringWaiting) ride this disc's edge. */
const DISC = { cx: 50, cy: 50.5, r: 45.5 }

/** The light disc an agent's logo sits on, a little skeuomorphic: shadow, lit body, bevelled rim. */
function Disc({ id, orch }: { id: string; orch: boolean }): React.JSX.Element {
  const { cx, cy, r } = DISC
  return (
    <g className="ink-disc">
      <defs>
        <radialGradient id={`${id}-sh`}>
          <stop offset="0.8" stopColor="#3a2c18" stopOpacity="0.26" />
          <stop offset="1" stopColor="#3a2c18" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ebe6dd" />
        </linearGradient>
        <radialGradient id={`${id}-gloss`} cx="0.5" cy="0.35" r="0.6">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.7" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="0.5" stopColor="#d8d1c4" stopOpacity="0.5" />
          <stop offset="1" stopColor="#8a7c66" stopOpacity="0.45" />
        </linearGradient>
      </defs>
      <circle cx={cx} cy={cy + 3} r={r + 3.5} fill={`url(#${id}-sh)`} />
      <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-body)`} />
      <ellipse cx={cx} cy={cy - 20} rx={r * 0.72} ry={r * 0.4} fill={`url(#${id}-gloss)`} />
      <circle cx={cx} cy={cy} r={r - 0.6} fill="none" stroke={`url(#${id}-rim)`} strokeWidth="1.2" />
      {orch && (
        <g fill="none" strokeWidth="1">
          <circle cx={cx} cy={cy + 0.6} r={r - 6} stroke="#ffffff" strokeOpacity="0.9" />
          <circle cx={cx} cy={cy} r={r - 6} stroke="#6f6250" strokeOpacity="0.28" />
        </g>
      )}
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
 * (14 px) keeps its logo too: a bare light disc would say nothing.
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
  const mark = harnessMark(preset)
  const mini = weight === 'mini'
  const k = WEIGHT[weight]
  const corner = cornerOf(status)
  // The ensō steps aside round a corner mark: a cut, so it works on any background.
  const uid = useId().replace(/:/g, '')
  const cutId = `ink-cut-${uid}`
  const discId = `ink-disc-${uid}`
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
          <Disc id={discId} orch={orch} />
        </g>
        {isBrand(mark)
          ? <g className="ink-glyph"><HarnessLogo mark={mark} /></g>
          : <Stroke name={mark} width={mini ? 9 : 6.2} seed={seed} transform={GLYPH} className="ink-glyph" />}
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
