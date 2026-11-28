import { harnessOfPreset } from '../../../shared/harness-catalog'
import almaLogo from './harness-logos/alma.png'
import devinLogo from './harness-logos/devin.png'
import agyLogo from './harness-logos/agy.png'
import deepseekLogo from './harness-logos/deepseek.svg'

/**
 * THE NEW HARNESSES' OWN MARKS (owner, 2026-11-28: "claude code/codex/
 * opencode/pi 之前的版本挺好的，不要变" — those four keep the ink marks they
 * have always had, in the picker and on their cards alike; the four added on
 * 2026-11-26 get the vendor's own artwork instead of a drawn stand-in).
 *
 * Sources: Antigravity's icon from antigravity.google, Devin's favicon from
 * app.devin.ai, DeepSeek's mark from Simple Icons (CC0-licensed file; the
 * brand remains its owner's trademark), and Alma's AppIcon from the installed
 * app. Any other preset gets no glyph: the row keeps the ink mark it had.
 */
const LOGO: Readonly<Record<string, string>> = {
  agy: agyLogo,
  devin: devinLogo,
  dsh: deepseekLogo,
  alma: almaLogo
}

export function harnessLogo(preset: string | null | undefined): string | null {
  const id = harnessOfPreset(preset)
  return id ? LOGO[id] ?? null : null
}

export function HarnessGlyph({ preset, size = 18 }: { preset: string; size?: number }): React.JSX.Element | null {
  const src = harnessLogo(preset)
  if (src === null) return null
  return <img className="pf-harness-glyph" src={src} alt="" width={size} height={size} draggable={false} aria-hidden="true" />
}
