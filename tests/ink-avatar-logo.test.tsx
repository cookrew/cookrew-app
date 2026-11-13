// AN AGENT'S FACE IS ITS MAKER'S LOGO ON A LIGHT DISC (owner 2026-11-13: "仅把产品
// 现有 avatar 图案中间的替换成原厂 logo", then "浅色底带点拟物，不要黑色框了").
// The disc replaces the black ensō; the middle is the harness's own logo, its
// colours fixed so a status never recolours it; a plain shell keeps the ink
// prompt; the status brush and corner marks stay as they were.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { InkAvatar } from '../src/renderer/src/zoom/InkAvatar'

const face = (preset: string, extra: Partial<Parameters<typeof InkAvatar>[0]> = {}): string =>
  renderToStaticMarkup(<InkAvatar id="a1" preset={preset} size={64} {...extra} />)

describe('the face', () => {
  it('draws each brand as its own logo, in its own colours', () => {
    expect(face('Claude Code')).toContain('fill="#D97757"')
    expect(face('Codex')).toContain('stop-color="#3941FF"')
    expect(face('OpenCode')).toContain('fill="#5A5858"')
    expect(face('Pi')).toContain('fill="#4D9ABF"')
    for (const preset of ['Claude Code', 'Codex', 'OpenCode', 'Pi']) expect(face(preset)).toContain('ink-logo-art')
  })

  it('keeps the ink prompt for a plain shell, with no logo', () => {
    const shell = face('Shell')
    expect(shell).not.toContain('ink-logo-art')
    expect(shell).toMatch(/<g class="ink-stroke ink-glyph"/)
  })

  it('stands on a light disc, not a black ensō', () => {
    const html = face('Claude Code')
    expect(html).toContain('class="ink-disc"')
    expect(html).toContain('stop-color="#ffffff"')
    // the ensō was the only ink stroke outside the glyph and the status
    expect(html.match(/class="ink-stroke"/g) ?? []).toHaveLength(0)
  })

  it('gives an orchestrator a groove inside the rim', () => {
    const circles = (html: string): number => (html.match(/<circle/g) ?? []).length
    expect(circles(face('Claude Code', { orch: true }))).toBe(circles(face('Claude Code')) + 2)
  })

  it('keeps the logo at the mini size, where the ink mark used to drop', () => {
    expect(face('Pi', { weight: 'mini' })).toContain('ink-logo-art')
  })

  it('never lets waiting recolour a logo: the logo blinks, the red rides the ring', () => {
    const waiting = face('Claude Code', { status: 'waiting' })
    expect(waiting).toContain('fill="#D97757"')
    expect(waiting).toContain('ink-zhu')
  })

  it('keeps every face its own gradients, so thirty on a page never share an id', () => {
    const html = renderToStaticMarkup(<>{[0, 1].map((i) => <InkAvatar key={i} id={`a${i}`} preset="Codex" />)}</>)
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
