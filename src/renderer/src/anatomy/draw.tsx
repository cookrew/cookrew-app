// The four SVG primitives the anatomy canvas draws with, as React components.
//
// Adapted from the anatomy skill's kit/react/draw.tsx (MIT), trimmed to what
// this canvas uses and cut free of the skill's `live` module so no hook comes
// with it. Class names match anatomy/iso.css, which anatomy.css re-points at
// Cookrew's own tokens.

import type { Flat, LineTone, SolidPaths, Tone } from './iso-kit'

const tenth = (value: number): number => Math.round(value * 10) / 10

/**
 * A prism: paper-coloured fill first so it hides what is behind, then the side
 * faces bucketed by how they face the light, the top, the crease and the
 * silhouette. Painting in that order is what makes a solid read as solid.
 */
export function Solid({
  paths,
  tone = 'hi',
  crease = 'faint',
  halo = false,
  lit = false,
  className,
  inner,
  children
}: {
  paths: SolidPaths
  tone?: Tone
  crease?: Tone | 'none'
  halo?: boolean
  /** The one part the reader should watch: filled with the accent, not the paper. */
  lit?: boolean
  className?: string
  /** Line markup placed under the outline — seams, bands, window frames. */
  inner?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <g
      className={className ? `iso-solid ${className}` : 'iso-solid'}
      data-lit={lit ? '' : undefined}
    >
      {halo ? <path className="iso-halo" d={paths.fill} /> : null}
      <path className="iso-fill" d={paths.fill} />
      {paths.shades.map((d, shade) =>
        d ? <path key={shade} className="iso-shade" data-shade={shade} d={d} /> : null
      )}
      <path className="iso-top" d={paths.top} />
      {crease === 'none' || !paths.crease ? null : (
        <path className="iso-line iso-crease" data-tone={crease} d={paths.crease} />
      )}
      {crease === 'none' || !paths.bevel ? null : (
        <path className="iso-line iso-bevel" data-tone={crease} d={paths.bevel} />
      )}
      {inner}
      <path className="iso-line iso-edge" data-tone={tone} d={paths.outline} />
      {children}
    </g>
  )
}

export function Line({
  d,
  tone = 'lo',
  className,
  free
}: {
  d: string
  tone?: LineTone
  className?: string
  /** Marks an end that is meant to stop on a bare face (a rule line, a tick). */
  free?: boolean
}): React.JSX.Element | null {
  if (!d) return null
  return (
    <path
      className={className ? `iso-line ${className}` : 'iso-line'}
      data-tone={tone}
      data-free={free ? '' : undefined}
      d={d}
    />
  )
}

export function Dots({
  points,
  size = 0.5,
  tone = 'mid'
}: {
  points: Flat[]
  size?: number
  tone?: Tone
}): React.JSX.Element {
  return (
    <g className="iso-dots" data-tone={tone}>
      {points.map(([x, y], index) => (
        <circle key={index} cx={tenth(x)} cy={tenth(y)} r={size} />
      ))}
    </g>
  )
}

/** Text laid flat on a face, via topMatrix / sideMatrix from the kit. */
export function FaceText({
  transform,
  children,
  size = 3,
  tone = 'mid',
  anchor = 'start'
}: {
  transform: string
  children: React.ReactNode
  size?: number
  tone?: Tone
  anchor?: 'start' | 'middle' | 'end'
}): React.JSX.Element {
  return (
    <text
      className="iso-face-text"
      data-tone={tone}
      transform={transform}
      fontSize={size}
      textAnchor={anchor}
    >
      {children}
    </text>
  )
}
