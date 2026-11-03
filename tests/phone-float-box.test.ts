// THE PHONE'S BOX FLOATS, ONE ROW (owner, 2026-11-03: "can the bottom input box
// be a floating box that takes no bottom-bar space, one row").
//
//   the dock is no band: a fixed layer, the box a pill over the page; the stage
//   runs to the screen's foot and what stood on the band clears the pill
//   through one variable, --cr-float-h (every width has it since; the phone its own).
//   at rest the pill is ONE row: the left chip, the words, 🎤, Send. The model
//   chip, ⌄, ⌨ and the keys float as a row above it while the box has focus,
//   the agent waits on you, the ear listens or the extras are open.
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
  it('hides the model chip and the tools at rest', () => {
    expect(phone).toMatch(/\.cr-prompt \.cr-prompt-tools,[^{]*\.cr-tune-menu[^{]*\{\s*display: none;/)
  })

  it('shows them above the words while focused, waited on, listening or with the extras open', () => {
    // Waited on: the ^ opens by itself then (extras-pref.ts · toolsOpen), so :has(.open) covers it.
    for (const why of [':focus-within', '.listening', ':has(.cr-prompt-more.open)']) expect(phone).toContain(why)
  })

  it('keeps the words row last, so the row typed in never moves', () => {
    const order = (sel: string): number => Number(phone.slice(phone.indexOf(sel)).match(/order: (-?\d+);/)?.[1])
    expect(order('body .cr-prompt-to')).toBeGreaterThan(order('body .cr-prompt::before'))
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

describe("the stage's floor", () => {
  it('is the pill top when the dock floats over the stage', () => {
    expect(stageFloor({ stageBottom: 772, dockTop: 708, viewport: 772 })).toBe(708)
  })

  it('is the stage bottom when the dock sits under it, or there is none', () => {
    expect(stageFloor({ stageBottom: 661, dockTop: 661, viewport: 772 })).toBe(661)
    expect(stageFloor({ stageBottom: 772, dockTop: null, viewport: 772 })).toBe(772)
  })
})
