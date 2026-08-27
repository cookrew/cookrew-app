import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'TerminalOverlay.tsx'),
  'utf8',
)
const styles = readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'),
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

  it('pins the live seam to a fixed viewport share instead of content height', () => {
    const live = styles.slice(styles.indexOf('.ctx-live {'), styles.indexOf('.ctx-live::before'))
    expect(live).toContain('flex: 0 0 72%')
    expect(live).toContain('min-height: 72%')
    expect(live).toContain('max-height: 72%')
    expect(live).toContain('position: sticky')
    expect(live).toContain('overflow: hidden')
    expect(live).not.toContain('min-height: 55%')
  })
})
