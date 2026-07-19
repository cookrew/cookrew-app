/** Cookrew icon set: chunky arcade glyphs on a 16-grid, square caps, drawn in
    currentColor so buttons and chips tint them. Sized via .cr-icon in CSS. */

export type CrIconName =
  | 'select'
  | 'terminal'
  | 'note'
  | 'browser'
  | 'connect'
  | 'fork'
  | 'expand'
  | 'collapse'
  | 'close'
  | 'mic'
  | 'speaker'
  | 'send'
  | 'attach'
  | 'plus'
  | 'caret-down'
  | 'caret-right'
  | 'check'
  | 'prev'
  | 'next'
  | 'canvas'
  | 'demo'
  | 'mobile'
  | 'bash'
  | 'search'
  | 'agent'
  | 'dot'

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7
} as const

const FILLED = {
  fill: 'currentColor',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinejoin: 'round'
} as const

const ICONS: Record<CrIconName, React.JSX.Element> = {
  select: <path {...FILLED} d="M4 1.8 L4 12.2 L6.9 9.9 L8.6 13.8 L10.8 12.8 L9.1 9 L12.6 8.6 Z" />,
  terminal: (
    <g {...STROKE} strokeWidth={1.8}>
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1" />
      <path d="M4.4 6.2 L7 8 L4.4 9.8" strokeLinecap="square" />
      <path d="M8.6 10.2 H11.6" strokeLinecap="square" />
    </g>
  ),
  note: (
    <g {...STROKE} strokeLinejoin="round">
      <path d="M10.6 2.6 L13.4 5.4 L6.2 12.6 L2.6 13.4 L3.4 9.8 Z" />
      <path d="M9 4.2 L11.8 7" />
    </g>
  ),
  browser: (
    <g {...STROKE} strokeWidth={1.6}>
      <circle cx="8" cy="8" r="5.7" />
      <ellipse cx="8" cy="8" rx="2.5" ry="5.7" />
      <path d="M2.3 8 H13.7" />
    </g>
  ),
  connect: (
    <g>
      <rect x="1.7" y="1.7" width="3.6" height="3.6" fill="currentColor" />
      <rect x="10.7" y="10.7" width="3.6" height="3.6" fill="currentColor" />
      <path {...STROKE} d="M5.3 3.5 C 11.5 3.5 4.5 12.5 10.7 12.5" />
    </g>
  ),
  fork: (
    <g {...STROKE}>
      <circle cx="4.4" cy="3.4" r="1.7" />
      <circle cx="11.6" cy="3.4" r="1.7" />
      <circle cx="8" cy="12.6" r="1.7" />
      <path d="M4.4 5.1 C 4.4 8.2 8 7.6 8 10.9 M11.6 5.1 C 11.6 8.2 8 7.6 8 10.9" />
    </g>
  ),
  expand: (
    <g {...STROKE} strokeWidth={1.8} strokeLinecap="square">
      <path d="M9.6 2.4 H13.6 V6.4 M13.4 2.6 L9.2 6.8" />
      <path d="M6.4 13.6 H2.4 V9.6 M2.6 13.4 L6.8 9.2" />
    </g>
  ),
  collapse: (
    <g {...STROKE} strokeWidth={1.8} strokeLinecap="square">
      <path d="M6.6 2.4 V6.6 H2.4 M6.4 6.4 L2.4 2.4" />
      <path d="M9.4 13.6 V9.4 H13.6 M9.6 9.6 L13.6 13.6" />
    </g>
  ),
  close: (
    <path {...STROKE} strokeWidth={2.1} strokeLinecap="square" d="M3.6 3.6 L12.4 12.4 M12.4 3.6 L3.6 12.4" />
  ),
  mic: (
    <g {...STROKE}>
      <rect x="6" y="1.9" width="4" height="7" rx="2" />
      <path d="M3.7 7.6 a4.3 4.3 0 0 0 8.6 0" />
      <path d="M8 11.9 V13.9" strokeLinecap="square" />
    </g>
  ),
  speaker: (
    <g>
      <path {...FILLED} d="M2.2 5.8 H5 L8.8 2.6 V13.4 L5 10.2 H2.2 Z" />
      <path {...STROKE} strokeWidth={1.6} d="M10.8 5.4 C 12 6.6 12 9.4 10.8 10.6 M12.9 3.6 C 14.8 5.6 14.8 10.4 12.9 12.4" />
    </g>
  ),
  send: (
    <g {...STROKE} strokeWidth={2} strokeLinecap="square">
      <path d="M2.4 8 H12.2" />
      <path d="M8.6 3.6 L13 8 L8.6 12.4" />
    </g>
  ),
  attach: (
    <path
      {...STROKE}
      strokeWidth={1.6}
      d="M11.9 6.9 L7 11.8 a3.1 3.1 0 0 1 -4.4 -4.4 L8.5 1.5 a2.2 2.2 0 0 1 3.1 3.1 L6.2 10 a1.1 1.1 0 0 1 -1.6 -1.6 L9.2 3.8"
    />
  ),
  plus: <path {...STROKE} strokeWidth={2.1} strokeLinecap="square" d="M8 2.6 V13.4 M2.6 8 H13.4" />,
  'caret-down': <path {...FILLED} d="M3.4 5.4 H12.6 L8 11.4 Z" />,
  'caret-right': <path {...FILLED} d="M5.4 3.4 V12.6 L11.4 8 Z" />,
  check: <path {...STROKE} strokeWidth={2.1} strokeLinecap="square" d="M2.8 8.6 L6.4 12 L13.2 4.2" />,
  prev: <path {...FILLED} d="M10.8 2.8 L5 8 L10.8 13.2 Z" />,
  next: <path {...FILLED} d="M5.2 2.8 L11 8 L5.2 13.2 Z" />,
  canvas: (
    <g {...STROKE}>
      <rect x="2.3" y="2.3" width="4.7" height="4.7" />
      <rect x="9" y="2.3" width="4.7" height="4.7" />
      <rect x="2.3" y="9" width="4.7" height="4.7" />
      <rect x="9" y="9" width="4.7" height="4.7" />
    </g>
  ),
  demo: (
    <g {...STROKE}>
      <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="1.6" />
      <circle cx="5.4" cy="5.4" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="10.6" r="1.15" fill="currentColor" stroke="none" />
    </g>
  ),
  mobile: (
    <g {...STROKE}>
      <rect x="4.2" y="1.7" width="7.6" height="12.6" rx="1.5" />
      <path d="M6.8 3.9 H9.2" strokeLinecap="square" />
      <circle cx="8" cy="11.7" r="0.95" fill="currentColor" stroke="none" />
    </g>
  ),
  bash: (
    <g {...STROKE} strokeWidth={2} strokeLinecap="square">
      <path d="M3.4 3.8 L8 8 L3.4 12.2" />
      <path d="M9.6 12.4 H13.2" />
    </g>
  ),
  search: (
    <g {...STROKE} strokeWidth={1.8}>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M10 10 L13.6 13.6" strokeWidth={2.1} strokeLinecap="square" />
    </g>
  ),
  agent: (
    <g {...STROKE}>
      <rect x="2.9" y="5.2" width="10.2" height="8" rx="1.4" />
      <rect x="5.5" y="8" width="1.7" height="1.7" fill="currentColor" stroke="none" />
      <rect x="8.8" y="8" width="1.7" height="1.7" fill="currentColor" stroke="none" />
      <path d="M8 5.2 V3.2" strokeLinecap="square" />
      <circle cx="8" cy="2.4" r="1" fill="currentColor" stroke="none" />
    </g>
  ),
  dot: <circle cx="8" cy="8" r="2.7" fill="currentColor" />
}

interface CrIconProps {
  name: CrIconName
  className?: string
}

/** Inline icon; decorative by default — pair with title/aria-label on the
    owning button or chip, which every call site already carries. */
export function CrIcon({ name, className }: CrIconProps): React.JSX.Element {
  return (
    <svg
      className={className ? `cr-icon ${className}` : 'cr-icon'}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  )
}
