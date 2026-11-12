import { memo, useId } from 'react'
import { BAIMIAO, brushPathCached, CORNER, harnessMark, type HarnessMark, type MarkName } from './ink-marks'
import { cornerOf, type CornerMark, type InkStatus } from './ink-status'

/**
 * An agent drawn in ink: its harness mark inside a round head, open, or
 * closed for an orchestrator (ink-marks.ts), with an antenna on the crown and
 * an ear at each side, so it reads as a bot at a glance (owner 2026-11-12).
 * The bot is baimiao (白描): fine and even lines, tapered only where they
 * land and lift. Its face is its harness's own logo, as its maker draws it
 * (HarnessLogo below: Claude's, Codex's, OpenCode's, Pi's); a plain shell
 * keeps the ink prompt. Paths are computed once per mark and kept. Drawn plain: a
 * rough-edge filter over every stroke costs a raster pass per agent, and at a
 * dozen agents on screen it is the frame, not the flourish.
 *
 * Its status (ink-status.ts) is a second line in red over the same ink:
 * working laps a third of a turn along the head and lights the antenna's
 * tip, waiting closes the ring and blinks it with the harness mark and the
 * tip (all red), done ticks the shoulder, and offline fades the ink and
 * writes a z there. The motion is CSS (zoom.css): a rotation and an opacity,
 * nothing that rebuilds a path per frame; idle, done and offline stand still.
 */
/**
 * EACH HARNESS IN ITS OWN LOGO (owner 2026-11-12: "Claude uses Claude's own
 * logo, Codex uses Codex's own"). The face of an agent is its harness's
 * logo, as its maker draws it: shape and colours unchanged, set in the
 * avatar's head (InkAvatar.tsx). A plain shell is no brand, so it keeps the
 * ink prompt (ink-marks.ts · shell).
 *
 * Only path data and colours are kept here, read from each maker's files:
 *   Claude    claude.ai/favicon.svg (Anthropic)
 *   Codex     the Codex app's icon (OpenAI): the cloud and its prompt; the
 *             vector is @lobehub/icons-static-svg's codex.svg (MIT), checked
 *             against the app's own icon-codex-light.png, in that icon's colours
 *   OpenCode  opencode.ai/favicon.svg: the mark, without its dark tile; the
 *             white that stood on the tile is the page's ink here
 *   Pi        pi.dev/logo-auto.svg
 * The logos are their makers' marks, shown to say which harness an agent runs.
 */

type BrandMark = Exclude<HarnessMark, 'shell'>

const isBrand = (mark: HarnessMark): mark is BrandMark => mark !== 'shell'

/** Where a logo sits in the head's 100-box: centred on the head, as wide as the old ink mark's strokes. */
const SIZE: Readonly<Record<BrandMark, number>> = { claude: 54, codex: 50, opencode: 46, pi: 48 }
const CENTRE = { x: 50, y: 50.5 }

const CLAUDE = 'M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z'
const CODEX = 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z'
const OPENCODE_FRAME = 'M384 416H128V96H384V416ZM320 160H192V352H320V160Z'
const OPENCODE_BLOCK = 'M320 224V352H192V224H320Z'
const PI: readonly { d: string; fill: string }[] = [{d: 'M165.29 165.29H517.36V400H400V282.65H165.29Z', fill: '#F09082'}, {d: 'M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z', fill: '#4D9ABF'}, {d: 'M517.36 400H634.72V634.72H517.36Z', fill: '#F1BE58'}]

/** A harness's logo, drawn in a 100-box (the head's), centred. */
const HarnessLogo = memo(function HarnessLogo({ mark }: { mark: BrandMark }): React.JSX.Element {
  const gradient = `codex-${useId().replace(/:/g, '')}`
  const s = SIZE[mark]
  const box = { x: CENTRE.x - s / 2, y: CENTRE.y - s / 2, width: s, height: s }
  if (mark === 'claude') {
    return (
      <svg className="ink-logo-art" {...box} viewBox="0 0 248 248">
        <path d={CLAUDE} fill="#D97757" />
      </svg>
    )
  }
  if (mark === 'codex') {
    return (
      <svg className="ink-logo-art" {...box} viewBox="0 0 24 24">
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">
            <stop stopColor="#B1A7FF" />
            <stop offset=".5" stopColor="#7A9DFF" />
            <stop offset="1" stopColor="#3941FF" />
          </linearGradient>
        </defs>
        {/* The prompt is white in the app's icon: white behind the cloud shows through its cut. */}
        <rect x="5.4" y="7.4" width="13.6" height="9.4" fill="#fff" />
        <path d={CODEX} fill={`url(#${gradient})`} fillRule="evenodd" clipRule="evenodd" />
      </svg>
    )
  }
  if (mark === 'opencode') {
    return (
      <svg className="ink-logo-art" {...box} viewBox="96 96 320 320">
        <path d={OPENCODE_BLOCK} fill="#5A5858" />
        <path d={OPENCODE_FRAME} fill="var(--zv-logo-ink)" fillRule="evenodd" clipRule="evenodd" />
      </svg>
    )
  }
  return (
    <svg className="ink-logo-art" {...box} viewBox="140 140 520 520">
      {PI.map((p) => <path key={p.fill} d={p.d} fill={p.fill} />)}
    </svg>
  )
})

const GLYPH = 'translate(14.5 15) scale(0.71)'
/** The head, a little smaller and lower than the box, so the antenna stands inside it. */
const HEAD = 'translate(50 54.5) scale(0.88) translate(-50 -50.5)'
/** The antenna's tip: a small open ring, lit red while the agent works or waits. */
const TIP = { cx: 50.6, cy: 2.4, r: 3.2 }

function Stroke({ name, width, seed, dry, transform, className, line = false }: { name: MarkName; width: number; seed: number; dry?: number; transform?: string; className?: string; line?: boolean }): React.JSX.Element {
  const p = brushPathCached(name, line ? { ...BAIMIAO, width, seed } : dry === undefined ? { width, seed } : { width, seed, dry })
  return (
    <g className={className ? `ink-stroke ${className}` : 'ink-stroke'} transform={transform}>
      {!line && <path className="ink-bleed" d={p.body} />}
      <path className="ink-body" d={p.body} />
      <circle className="ink-body" cx={p.drop.x} cy={p.drop.y} r={p.drop.r} />
      {!line && <path className="ink-bristle" d={p.bristles} />}
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
 * How heavy the status line is for the size the face is drawn at: the
 * smaller the face, the fatter the red has to be to be seen. A mini face
 * (14 px) drops the harness mark and keeps the head, its antenna and its status.
 */
export type InkWeight = 'large' | 'regular' | 'small' | 'mini'
const WEIGHT: Record<InkWeight, number> = { large: 1, regular: 1.2, small: 1.45, mini: 1.9 }
/** The red's width on the head before the weight; the head's own line is 3.4. */
const RIDE = 4.6
const CORNER_WIDTH: Record<CornerMark, number> = { tick: 5.6, zee: 3.8 }
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
  // The head steps aside round a corner mark: a cut, so it works on any background.
  const cutId = `ink-cut-${useId().replace(/:/g, '')}`
  const cornerPaths = corner ? brushPathCached(corner, { ...BAIMIAO, width: CORNER_WIDTH[corner], seed }) : null
  const bot = mini ? 6 : 3
  const mark = harnessMark(preset)
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
      {/* Each part a child of its own: a new agent's face (prompt-face.css) hides all but the mark. */}
      <g className="ink-own">
        <g transform={HEAD}>
          <g mask={cornerPaths ? `url(#${cutId})` : undefined}>
            <Stroke name={orch ? 'ensoClosed' : 'enso'} width={mini ? 7.5 : 3.4} seed={seed} line />
          </g>
        </g>
        {!mini &&
          (isBrand(mark) ? (
            <g className="ink-glyph ink-logo" transform={HEAD}>
              <HarnessLogo mark={mark} />
            </g>
          ) : (
            <Stroke name={mark} width={6.2} seed={seed} transform={`${HEAD} ${GLYPH}`} className="ink-glyph" />
          ))}
        <g className="ink-ears">
          <Stroke name="earLeft" width={bot} seed={seed} line />
          <Stroke name="earRight" width={bot} seed={seed + 3} line />
        </g>
        <g className="ink-antenna">
          <Stroke name="antenna" width={bot} seed={seed} line />
          <circle className="ink-tip" cx={TIP.cx} cy={TIP.cy} r={TIP.r} strokeWidth={mini ? 4 : 2.2} />
        </g>
      </g>
      <g transform={HEAD}>
        {status === 'working' && (
          <g className="ink-zhu ink-lap">
            {/* unpainted: centres the group's box on the head, so the lap turns about it */}
            <circle cx="50" cy="50.5" r="62" fill="none" stroke="none" />
            <Stroke name="ringWorking" width={RIDE * 1.08 * k} seed={seed} line />
          </g>
        )}
        {status === 'waiting' && (
          <g className="ink-zhu">
            <Stroke name="ringWaiting" width={RIDE * 1.22 * k} seed={seed} line />
          </g>
        )}
        {corner && <Stroke name={corner} width={CORNER_WIDTH[corner]} seed={seed} transform={cornerAt(k)} className={status === 'done' ? 'ink-corner ink-zhu' : 'ink-corner'} line />}
      </g>
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

/**
 * An ink tie, stretched by its holder's transform: one fine baimiao line, lifted
 * off the page by its shadow just under it (the holder turns it so the shadow
 * always falls down and right, zoom-frame.ts · ties).
 */
export const InkTie = memo(function InkTie(): React.JSX.Element {
  return (
    <svg className="ink-tie" viewBox="0 40 100 20" preserveAspectRatio="none" aria-hidden="true">
      <g className="ink-tie-shade" transform="translate(0 1.6)">
        <Stroke name="tie" width={2.6} seed={7} line />
      </g>
      <Stroke name="tie" width={1.6} seed={7} line />
    </svg>
  )
})
