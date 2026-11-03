// THE ONE BAR ON A PHONE: the route on the left, the function bar on the
// right (header.css). The route gives its words, never its steps; the function
// bar gives nothing, because everything on it moves or acts (2026-10-29, the
// owner's iPhone: one bar, buttons top right, device / workspace / agent).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/header.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const block = (query: string): string => {
  const start = css.indexOf(`@media (${query})`)
  return start < 0 ? '' : css.slice(start, css.indexOf('\n}\n', start) + 3)
}
const narrow = block('max-width: 700px')
const portrait = block('max-width: 480px')

describe('the route', () => {
  it('may shrink, and gives the device before the workspace', () => {
    expect(css).toMatch(/\.cr-route \{[^}]*flex: 1 1 auto[^}]*min-width: 0/)
    expect(css).toMatch(/\.cr-route-device \{[^}]*flex-shrink: 3/)
    expect(css).toMatch(/\.cr-route-workspace \{[^}]*flex-shrink: 2/)
  })
  it('names ellipsize instead of walking off the bar', () => {
    expect(css).toMatch(/\.cr-route-label \{[^}]*text-overflow: ellipsis/)
  })
  it('names the open agent without a drag region over it, and keeps a few letters of it', () => {
    expect(css).toMatch(/\.cr-route-here \{[^}]*min-width: 3ch[^}]*-webkit-app-region: no-drag/)
  })
  it('narrow: the device keeps its icon', () => {
    expect(narrow).toMatch(/\.cr-route-device \.cr-route-label \{[^}]*display: none/)
  })
  // The phone's type (owner, 2026-11-02): at 16px a 64px cap read "Cookr…" with half the bar
  // free, so the names take the room the bar leaves them, each down to a few letters.
  it('portrait: the workspace and agent names take the free room and keep a few letters', () => {
    expect(portrait).toMatch(/\.cr-route-workspace \.cr-route-label \{[^}]*max-width: none;[^}]*min-width: 2\.5em/)
    expect(portrait).toMatch(/\.cr-route-agent \.cr-route-label \{[^}]*max-width: none;[^}]*min-width: 3em/)
  })
})

describe('the function bar', () => {
  it('never shrinks', () => {
    expect(css).toMatch(/\.cr-fn \{[^}]*flex: 0 0 auto/)
  })
  it('opens More under its button, inside the screen', () => {
    expect(css).toMatch(/\.cr-more-menu \{[^}]*position: absolute[^}]*right: 0/)
    expect(css).toMatch(/\.cr-more-menu \{[^}]*max-width: calc\(100vw - 16px\)/)
  })
})
