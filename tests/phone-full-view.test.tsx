// THE PHONE'S FULL VIEW, TOP AND BOTTOM (owner, 2026-11-02: "the first row, the
// second row and the bottom bar as recommended; the middle stays" —
// docs/phone-full-view-2026-11-02.html).
//
//   row 1: the bar names the agent (‹ face name · state); the device and
//          workspace steps fold into its ‹, and the head's own name goes.
//   row 2: the troop, faces stacked, in the same row as CHAT ✎+ ⊕+.
//   box:   words + Send on the first row, chips that shorten instead of
//          wrapping, a placeholder without the name, and the agent's keys
//          folded behind ⌨ unless the agent is waiting on you.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rowSpot } from '../src/renderer/src/pets/pet-dock'
import { fullRouteWords } from '../src/renderer/src/stage/full-route'

const css = (path: string): string => readFileSync(path, 'utf8')

describe('row 2: the troop stands in the head row, left of the tools', () => {
  const row = { left: 8, top: 57, width: 396, height: 40, toolsLeft: 280 }
  const troop = { width: 130, height: 28 }
  const phone = { width: 412, height: 772 }

  it('the crew starts at the row when it has it to itself, centred on it', () => {
    const at = rowSpot('right', row, troop, phone)
    expect(at.left).toBe(row.left)
    expect(at.top).toBe(row.top + (row.height - troop.height) / 2)
  })

  it('beside the browsers and notes, the crew ends 8 px before the tools', () => {
    expect(rowSpot('right', row, troop, phone, true).left + troop.width).toBe(row.toolsLeft - 8)
  })

  it('the browsers and notes start at the row', () => {
    expect(rowSpot('left', row, troop, phone).left).toBe(row.left)
  })

  it('a crew wider than the room left keeps to the row, never off its left edge', () => {
    expect(rowSpot('right', row, { width: 400, height: 28 }, phone, true).left).toBe(row.left)
  })
})

describe('row 1: the bar says the state in one word', () => {
  it('the state alone when nothing is open: no "nothing open"', () => {
    expect(fullRouteWords('idle', { browsers: 0, notes: 0 })).toEqual(['resting'])
  })

  it('what is open after it, counted', () => {
    expect(fullRouteWords('working', { browsers: 2, notes: 1 })).toEqual(['working', '2 browsers', '1 note'])
  })
})

describe('row 1: the route folds on a phone, in an agent full view only', () => {
  const route = readFileSync('src/renderer/src/HeaderRoute.tsx', 'utf8')
  const header = css('src/renderer/src/header.css')

  it('offers a way back and a place for the full view to say who it is', () => {
    expect(route).toContain('cr-route-back')
    expect(route).toContain('setFullRouteSlot')
  })

  it('hides the device and workspace steps only at phone width', () => {
    const phone = header.slice(header.lastIndexOf('@media (max-width: 700px)'))
    expect(phone).toMatch(/\.cr-route\.has-full \.cr-route-device/)
    expect(header).toMatch(/\.cr-route-back,\s*\.cr-route-full\s*\{\s*display: none;/)
  })

  it('the round ‹ and the head\'s own name step aside in the agent full view', () => {
    const full = css('src/renderer/src/zoom/full-views.css')
    expect(full).toMatch(/body\.cr-full-agent \.zv-root\[data-full='true'\] \.zv-controls/)
    expect(full).toMatch(/\.zv-fullview\.agent \.zv-fv-who/)
  })
})

describe('the box on a phone', () => {
  const draw = async (over: Record<string, unknown> = {}): Promise<string> => {
    const store = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    g.window = g.window ?? globalThis
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
    const agents = [{ id: 'l', name: 'Lark', remote: false }]
    return renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: 'l', agents, harnesses: ['Claude Code'], nodes: [], ...over }))
  }

  it('says no name in the placeholder: the chip and the bar already do', async () => {
    const html = await draw()
    expect(html).toContain('placeholder="Reply… · # a note or browser"')
    expect(html).not.toContain('placeholder="Prompt Lark')
  }, 20_000)

  it('folds the agent\'s keys behind ⌨ while the agent is not asking', async () => {
    const html = await draw()
    expect(html).toContain('aria-label="Agent keys"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/class="cr-prompt to-agent[^"]* keys-folded/)
  })

  it('puts Send on the first row and caps the chips so the second never wraps', () => {
    const box = css('src/renderer/src/prompt/global-prompt.css')
    const phone = box.slice(box.indexOf('@media (max-width: 700px)'))
    expect(phone).toMatch(/> button\[type='submit'\]\s*\{[^}]*order: -1/)
    expect(phone).toMatch(/\.cr-prompt-to\s*\{[^}]*max-width: 38%/)
    // The model takes what the name leaves, up to its own width: grown from 0, it never wraps the row.
    expect(phone).toMatch(/\.cr-tune-menu\s*\{[^}]*flex: 1 1 0;[^}]*max-width: max-content/)
    expect(phone).toMatch(/\.cr-prompt\.keys-folded \.voice-bar\s*\{\s*display: none;/)
  })
})
