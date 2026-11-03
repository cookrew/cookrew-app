// THE PHONE'S BOX FLOATS, ONE ROW (owner, 2026-11-03: "can the bottom input box
// be a floating box that takes no bottom-bar space, one row").
//
//   the dock is no band: a fixed layer, the box a pill over the page; the stage
//   runs to the screen's foot and what stood on the band clears the pill
//   through one variable, --cr-float-h (every width has it since; the phone its own).
//   at rest the pill is ONE row: the left chip, the words, 🎤, Send. The model
//   chip, ⌄, ⌨ and the keys float as a row above it while the box has focus,
//   the agent waits on you, the ear listens or the extras are open.
// 2026-11-04 (task "Phone tray chips float"): that row is no longer a row
//   INSIDE the pill, growing it to two: it is a see-through row of chips of
//   its own, 8px over a pill that stays one row, 48px. It swipes sideways and
//   rides the keyboard with the box; what clears the box clears it too.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageFloor } from '../src/renderer/src/pets/stage-floor'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')
const box = read('prompt', 'global-prompt.css')
const phone = box.slice(box.indexOf('THE BOX FLOATS, ONE ROW'))

describe('the dock floats on a phone', () => {
  it('is a fixed, see-through layer that lets taps through around the pill', () => {
    expect(phone).toMatch(/body \.cr-app:not\(\.cr-embed\) > \.cr-dock\.cr-dock \{[^}]*position: fixed;[^}]*background: transparent;[^}]*pointer-events: none;/)
    expect(phone).toMatch(/\.dock-canvas > \* \{\s*pointer-events: auto;/)
  })

  it('defines the clearance only on a phone, and the full view and the zoom bar read it', () => {
    expect(phone).toMatch(/body \.cr-app:not\(\.cr-embed\) \{[^}]*--cr-float-h:/)
    expect(read('zoom', 'full-views.css')).toMatch(/padding-bottom: var\(--cr-float-h/)
    expect(read('zoom', 'zoom.css')).toMatch(/bottom: var\(--cr-float-h/)
  })
})

describe('one row at rest, the tray above it when needed', () => {
  it('hides the tray at rest', () => {
    expect(phone).toMatch(/body \.cr-prompt \.cr-prompt-tray \{\s*display: none;/)
  })

  it('shows it while focused, waited on, listening or with the extras open', () => {
    // Waited on: the ^ opens by itself then (extras-pref.ts · toolsOpen), so :has(.open) covers it.
    expect(phone).toMatch(/body \.cr-prompt:is\(:focus-within, \.listening, :has\(\.cr-prompt-more\.open\)\) \.cr-prompt-tray \{\s*display: flex;/)
  })

  it('keeps the words row last, so the row typed in never moves', () => {
    const order = (sel: string): number => Number(phone.slice(phone.indexOf(sel)).match(/order: (-?\d+);/)?.[1])
    expect(order('body .cr-prompt input')).toBeGreaterThan(order('body .cr-prompt-to'))
    expect(order("body .cr-prompt > button[type='submit']")).toBeGreaterThan(order('body .cr-prompt > .voice-mic'))
  })

  it('stands the mic beside Send, out of the tools', () => {
    const jsx = read('prompt', 'GlobalPrompt.tsx')
    const tools = jsx.slice(jsx.indexOf('<span className="cr-prompt-tools"'), jsx.indexOf('type="submit"'))
    const toolsEnd = tools.lastIndexOf('</span>')
    expect(tools.slice(toolsEnd)).toContain('voice-mic')
    expect(tools.slice(0, toolsEnd)).not.toContain('voice-mic')
  })
})

describe('the tray floats as its own row of chips (task "Phone tray chips float")', () => {
  const jsx = read('prompt', 'GlobalPrompt.tsx')
  /** The tray's JSX, from its opening tag to its closing one. */
  const tray = (): string => {
    const at = jsx.indexOf('<div className="cr-prompt-tray"')
    expect(at).toBeGreaterThan(-1)
    return jsx.slice(at, jsx.indexOf('</div>', jsx.indexOf('</VoiceBar>', at)))
  }
  const block = (selector: string): string => {
    const at = phone.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return phone.slice(at, phone.indexOf('}', at))
  }

  it('holds model · effort, the item and the tools in one wrapper; the words, 🎤 and Send stay in the pill', () => {
    const inside = tray()
    for (const part of ['<CardTune', '<NewAgentTune', '<ItemRefChip', '<span className="cr-prompt-tools"', '<ExtrasToggle', '<VoiceBar']) expect(inside).toContain(part)
    for (const part of ['<input', 'voice-mic', 'type="submit"', 'cr-prompt-to pf-chip', 'cr-prompt-harness']) expect(inside).not.toContain(part)
  })

  it('keeps the pill one row, 48px: no line break, nothing of the tray ordered into it', () => {
    expect(phone).not.toContain('body .cr-prompt::before')
    expect(block('  body .cr-prompt')).toContain('min-height: 48px;')
    expect(phone).not.toMatch(/order: -4;/)
    // The clearance is the pill (48), 8px of air and its foot.
    expect(phone).toMatch(/--cr-float-h: calc\(56px \+ max\(8px, env\(safe-area-inset-bottom, 0px\)\)\);/)
  })

  it('stands 8px over the pill, out of its flow, so the pill never grows', () => {
    const row = block('  body .cr-prompt .cr-prompt-tray')
    expect(row).toContain('position: absolute;')
    // Its padding gives the chips' shadows room inside the scroller; the chips' foot is 8px over the pill.
    expect(row).toContain('bottom: calc(100% + 8px - var(--cr-tray-pad));')
    expect(row).toContain('padding: var(--cr-tray-pad) 8px;')
    expect(row).toContain('align-items: flex-end;')
  })

  it('is see-through, so the gaps between chips let taps through to the page', () => {
    const row = block('  body .cr-prompt .cr-prompt-tray')
    expect(row).toContain('background: none;')
    expect(row).toContain('pointer-events: none;')
    expect(block('  body .cr-prompt .cr-prompt-tray *')).toContain('pointer-events: auto;')
    // The keys' group is a box with gaps of its own: those let taps through too.
    expect(block('  body .cr-prompt .cr-prompt-tray .voice-keys')).toContain('pointer-events: none;')
  })

  it('gives each chip its own small shadow, over whatever page is under it', () => {
    // A drop shadow on the buttons, so it adds to whatever line the chip's own rules draw.
    const shadow = phone.match(/([^{}]*\.cr-prompt-tray \.cr-btn,[^{]*)\{([^}]*)\}/)
    expect(shadow?.[2]).toContain('filter: drop-shadow(')
    // Never on a wrapper: a filter would hold a rising (fixed) menu inside it.
    expect(shadow?.[1]).not.toMatch(/\.cr-tune-menu[,\s]|\.cr-prompt-new[,\s]/)
  })

  it('swipes sideways, one line, no scrollbar, every chip its own width', () => {
    const row = block('  body .cr-prompt .cr-prompt-tray')
    expect(row).toContain('flex-wrap: nowrap;')
    expect(row).toContain('overflow-x: auto;')
    expect(row).toContain('scrollbar-width: none;')
    expect(phone).toMatch(/\.cr-prompt-tray::-webkit-scrollbar \{\s*display: none;/)
    expect(block('  body .cr-prompt .cr-prompt-tray > *')).toContain('flex: none;')
    // The tools are chips of the row, not a row of their own.
    expect(box).toMatch(/  body \.cr-prompt \.cr-prompt-tools \{\s*display: contents;/)
  })

  it('rides the keyboard with the box: it is inside the dock, which stands on --kb-inset', () => {
    expect(phone).toMatch(/\.cr-dock\.cr-dock \{[^}]*bottom: var\(--kb-inset, 0px\);/)
    expect(jsx.indexOf('<div className="cr-prompt-tray"')).toBeGreaterThan(jsx.indexOf('<form'))
    expect(jsx.indexOf('<div className="cr-prompt-tray"')).toBeLessThan(jsx.indexOf('</form>'))
  })

  it('lifts what stands above the box (the who-picker, the choice box) by its height while it shows', () => {
    expect(block('  body .cr-prompt')).toContain('--cr-tray-lift: 0px;')
    expect(phone).toMatch(/:has\(\.cr-prompt-more\.open\)\) \{\s*--cr-tray-lift: calc\(var\(--cr-tray-h\) \+ 8px\);/)
    expect(read('prompt', 'prompt-face.css')).toMatch(/\.pf-who \{[^}]*bottom: calc\(100% \+ 8px \+ var\(--cr-tray-lift, 0px\)\);/)
  })

  it('grows the clearance (the full view, the zoom bar) by its height while it shows, never while folded', () => {
    const grown = phone.match(/([^{}]*)\{\s*--cr-float-h: calc\(56px \+ var\(--cr-tray-h\) \+ 8px \+ max\(8px, env\(safe-area-inset-bottom, 0px\)\)\);/)
    expect(grown).not.toBeNull()
    const selector = grown?.[1] ?? ''
    expect(selector).toContain(':not(.folded):is(:focus-within, .listening)')
    expect(selector).toContain(':not(.folded) .cr-prompt-more.open')
    // :has() inside :has() is no selector at all: the whole rule would drop.
    for (const part of selector.split(',')) expect(part.match(/:has\(/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('stays in the one row on a wide screen', () => {
    const wide = box.slice(0, box.indexOf('THE BOX FLOATS, ONE ROW'))
    expect(wide).toMatch(/\.cr-prompt-tray \{\s*display: contents;/)
  })
})

describe("the stage's floor", () => {
  it('is the pill top when the dock floats over the stage', () => {
    expect(stageFloor({ stageBottom: 772, dockTop: 708, viewport: 772 })).toBe(708)
  })

  it("is the tray's top while it floats over the pill", () => {
    expect(stageFloor({ stageBottom: 772, dockTop: 708, viewport: 772, trayTop: 666 })).toBe(666)
    expect(stageFloor({ stageBottom: 772, dockTop: 708, viewport: 772, trayTop: null })).toBe(708)
  })

  it('is the stage bottom when the dock sits under it, or there is none', () => {
    expect(stageFloor({ stageBottom: 661, dockTop: 661, viewport: 772 })).toBe(661)
    expect(stageFloor({ stageBottom: 772, dockTop: null, viewport: 772 })).toBe(772)
  })
})
