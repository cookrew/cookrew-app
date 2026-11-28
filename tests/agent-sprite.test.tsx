// The dock's row marks (AgentSprite.tsx): the four originals keep their pixel
// drawings, the harnesses added on 2026-11-26 show the vendor's own mark, and a
// preset that is no harness keeps the invader (owner, 2026-11-28: "别搞漏了").

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentSprite, spriteForPreset } from '../src/renderer/src/nodes/AgentSprite'

const draw = (preset: string): string => renderToStaticMarkup(<AgentSprite preset={preset} />)

describe('a dock row’s mark', () => {
  it("the new harnesses show the vendor's mark, not a pixel drawing", () => {
    for (const preset of ['Antigravity CLI', 'Devin', 'DeepSeek Harness', 'Alma']) {
      const html = draw(preset)
      expect(html, preset).toContain('vi-sprite-logo')
      expect(html, preset).toMatch(/<img [^>]*src="[^"]+"/)
    }
  })

  it('Claude Code, Codex, OpenCode and Pi keep the sprites they had', () => {
    for (const preset of ['Claude Code', 'Codex', 'OpenCode', 'Pi']) {
      const html = draw(preset)
      expect(html, preset).not.toContain('vi-sprite-logo')
      expect(html, preset).toContain('<svg')
    }
    expect(draw('My team')).toContain('<svg')
  })

  it('the sprite kinds are still the harness names', () => {
    expect(spriteForPreset('Claude Code')).toBe('claude')
    expect(spriteForPreset('Antigravity CLI')).toBe('agy')
    expect(spriteForPreset('Alma')).toBe('alma')
    expect(spriteForPreset('Whatever')).toBe('shell')
  })
})
