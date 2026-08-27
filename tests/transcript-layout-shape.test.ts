import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'TerminalOverlay.tsx'),
  'utf8',
)
describe('terminal transcript layout', () => {
  it('uses one nested transcript/live seam on desktop and phone', () => {
    const wrap = source.slice(source.indexOf('<div className="popout-terminal-wrap">'))
    expect(wrap).toContain('<TranscriptView')
    expect(wrap).toContain('<div ref={containerRef} className="popout-terminal" />')
    expect(wrap.indexOf('<div ref={containerRef} className="popout-terminal" />'))
      .toBeLessThan(wrap.indexOf('</TranscriptView>'))
    expect(source).not.toContain('LAB_CUT')
    expect(source).not.toContain('markStage')
  })

})
