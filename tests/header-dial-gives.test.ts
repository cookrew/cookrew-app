// THE DIAL GIVES BEFORE THE NAMES (owner, 2026-11-01, Samsung Browser): with
// a zoomed agent's model dial and LIVE on the bar, the route read "C." / "L..",
// the device's and the workspace's icons on top of each other. On a phone the
// route now has a floor and the zoom slot is the one thing on the function bar
// that shrinks, so the dial's model name is what ellipsizes (header.css).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/header.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const block = (query: string): string => {
  const start = css.indexOf(`@media (${query})`)
  return start < 0 ? '' : css.slice(start, css.indexOf('\n}\n', start) + 3)
}
const narrow = block('max-width: 700px')
const portrait = css.slice(css.lastIndexOf('@media (max-width: 480px)'))
const ink = readFileSync('src/renderer/src/zoom/ink-theme.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('on a phone', () => {
  it('the route keeps a floor and does not shrink under it', () => {
    expect(narrow).toMatch(/\.cr-route \{[^}]*flex: 1 0 min\(200px, calc\(100vw - 196px\)\)/)
  })

  it("the device's icons stay whole", () => {
    expect(narrow).toMatch(/\.cr-route-device \{[^}]*flex-shrink: 0/)
  })

  it('the function bar may shrink, but only through the zoom slot', () => {
    expect(narrow).toMatch(/\.cr-fn \{[^}]*flex: 0 1 auto[^}]*min-width: 0/)
    expect(narrow).toMatch(/\.cr-fn > :not\(\.cr-zoom-slot\) \{[^}]*flex-shrink: 0/)
    expect(narrow).toMatch(/\.cr-zoom-slot \{[^}]*flex: 0 1 auto/)
  })

  it('the dial cuts to a few letters and its caret, never spilling', () => {
    expect(narrow).toMatch(/\.cr-tune-menu-btn \{[^}]*min-width: 28px[^}]*overflow: hidden/)
    expect(css).toMatch(/\.cr-tune-menu-model \{[^}]*min-width: 0[^}]*text-overflow: ellipsis/)
  })

  it('portrait: the effort leaves the dial to the model, and the steps give their padding', () => {
    expect(portrait).toMatch(/\.cr-tune-menu-effort \{[^}]*display: none/)
    expect(ink).toMatch(/@media \(max-width: 480px\) \{\s*body\.cr-ink :is\(\.cr-route-btn, \.cr-route-here\) \{[^}]*padding: 3px 4px/)
  })

  it("LIVE keeps its size: it acts, so it is not what gives", () => {
    expect(css).toMatch(/\.cr-look-toggle \{[^}]*flex: 0 0 auto/)
  })
})

describe('on the desktop', () => {
  it('the function bar still never shrinks', () => {
    expect(css).toMatch(/\.cr-fn \{\s*flex: 0 0 auto/)
  })
})
