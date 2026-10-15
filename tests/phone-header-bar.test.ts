// THE PHONE'S BAR IN PORTRAIT: seven things on one line, and the workspace
// chip is the one that must never be pushed off the right edge (2026-10-15,
// the owner's iPhone at 390 px: the chip was cut off behind the routing lamp).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/styles.css', 'utf8')
const portrait = (() => {
  // The block is found by its own comment: `.cr-header` has rules elsewhere too.
  const at = css.indexOf('THE BAR IN PORTRAIT HAS ONE LINE')
  const start = css.lastIndexOf('@media (max-width: 480px)', at)
  // Nested rules close with an indented brace; the query's own closes at column 0.
  return css.slice(start, css.indexOf('\n}\n', at) + 3)
})()

describe('the portrait bar', () => {
  it('lives under the 480 px phone query', () => {
    expect(portrait.startsWith('@media (max-width: 480px)')).toBe(true)
  })
  it('the workspace chip cannot shrink and shows its icon only', () => {
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-ws \{[^}]*flex: 0 0 auto/)
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-ws-name \{[^}]*display: none/)
  })
  it('the count beside the coin goes — the board has it — and the marks lose their slack', () => {
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-header-status \.cr-kicker \{[^}]*display: none/)
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-header \{[^}]*gap: 6px/)
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-hand-mark img \{[^}]*height: 22px/)
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-viewseg button \{[^}]*padding: 5px 8px/)
  })
  it('the path badge is the one thing that may give, by its word, never by its place', () => {
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-path \{[^}]*flex: 0 1 auto/)
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-path \{[^}]*min-width: 0/)
    expect(portrait).toMatch(/body\.cookrew-mobile \.cr-path-word \{[^}]*text-overflow: ellipsis/)
  })
})
