import { memo } from 'react'
import { brushPathCached, harnessMark, type MarkName } from './ink-marks'

/**
 * An agent drawn in ink: its harness mark inside an ensō, open, or closed for
 * an orchestrator (ink-marks.ts). Paths are computed once per mark and kept.
 * Drawn plain: a rough-edge filter over every stroke costs a raster pass per
 * agent, and at a dozen agents on screen it is the frame, not the flourish.
 */
const GLYPH = 'translate(14.5 15) scale(0.71)'

function Stroke({ name, width, seed, transform }: { name: MarkName; width: number; seed: number; transform?: string }): React.JSX.Element {
  const p = brushPathCached(name, { width, seed })
  return (
    <g className="ink-stroke" transform={transform}>
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

export const InkAvatar = memo(function InkAvatar({ id, preset, orch = false, size }: { id: string; preset: string; orch?: boolean; size?: number }): React.JSX.Element {
  const seed = seedOf(id)
  return (
    <svg className="ink-avatar" viewBox="-4 -4 108 108" width={size} height={size} aria-hidden="true">
      <Stroke name={orch ? 'ensoClosed' : 'enso'} width={4.6} seed={seed} />
      <Stroke name={harnessMark(preset)} width={6.2} seed={seed} transform={GLYPH} />
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
