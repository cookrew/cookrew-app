import { harnessOfPreset } from '../../../shared/harness-catalog'
import almaLogo from './harness-logos/alma.png'
import codexLogo from './harness-logos/codex.png'
import devinLogo from './harness-logos/devin.png'
import agyLogo from './harness-logos/agy.png'
import claudeLogo from './harness-logos/claude.svg'
import deepseekLogo from './harness-logos/deepseek.svg'
import opencodeLogo from './harness-logos/opencode.svg'
import piLogo from './harness-logos/pi.svg'

/**
 * A HARNESS'S OWN MARK, for the agent options (owner, 2026-11-28: the picker
 * shows the harness's original logo, not an ink drawing of one).
 *
 * Sources, all the vendor's own artwork: the SVG marks are Simple Icons
 * (CC0-licensed files; the brands themselves remain their owners' trademarks)
 * and the raster marks are the vendors' own touch icons — Anthropic's and
 * OpenAI's, Antigravity's from antigravity.google, Devin's favicon from
 * app.devin.ai, DeepSeek's mark from Simple Icons, and Alma's AppIcon taken
 * from the installed app. A preset that is no harness gets no glyph and the
 * row keeps its text alone.
 */
const LOGO: Readonly<Record<string, string>> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
  pi: piLogo,
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
