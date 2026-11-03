// THE CARET COMES BACK TO THE BOX (owner 2026-11-01): once the agent's harness
// is picked and its model / effort set, the prompt is what is typed next, so
// each pick in a chip puts the caret in the prompt box. On a phone that brings
// the keyboard up under a menu that may still be open, so the box's menus ride
// the keyboard as the dock does (rise-anchor.ts).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { keyboardCover, riseOver, riseStyle, typesIntoBox } from '../src/renderer/src/prompt/rise-anchor'

const src = (file: string): string => readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

describe('a menu rising over the dock', () => {
  it('reads the published keyboard cover, 0 when there is none', () => {
    expect(keyboardCover('')).toBe(0)
    expect(keyboardCover('0px')).toBe(0)
    expect(keyboardCover('312px')).toBe(312)
    expect(keyboardCover('nope')).toBe(0)
    expect(keyboardCover('-4px')).toBe(0)
  })

  it('sits over its chip, measured as if no keyboard were up', () => {
    // A desktop: no cover, the chip 40 px off the foot of an 800 px window.
    expect(riseOver({ left: 120, top: 760 }, 800, 0)).toEqual({ left: 120, bottom: 46 })
    // A phone with the keyboard up: the dock (and the chip) ride 300 px higher.
    expect(riseOver({ left: 12, top: 460 }, 800, 300)).toEqual({ left: 12, bottom: 46 })
    expect(riseOver({ left: 0, top: 900 }, 800, 0).bottom).toBe(0)
  })

  it('adds the live cover back, so it moves with the keyboard and keeps its room', () => {
    const style = riseStyle({ left: 12, bottom: 46 }, 12)
    expect(style.left).toBe(12)
    expect(style.bottom).toBe('calc(46px + var(--kb-inset, 0px))')
    expect(style.maxHeight).toBe('calc(100vh - 58px - var(--kb-inset, 0px))')
  })

  it('scrolls when the keyboard takes its room', () => {
    const css = src('prompt/global-prompt.css')
    expect(css).toMatch(/\.cr-prompt-new-menu,\s*\n\.cr-prompt-tune-menu \{\s*\n\s*overflow-y: auto;/)
  })

  it('is how every menu of the box is placed', () => {
    expect(src('prompt/HarnessMenu.tsx')).toContain('style={riseStyle(at, GAP)}')
    expect(src('prompt/NewAgentTune.tsx')).toContain('style={riseStyle(at, GAP)}')
    expect(src('nodes/TuneMenu.tsx')).toContain('riseStyle(risen, EDGE)')
    for (const file of ['prompt/GlobalPrompt.tsx', 'prompt/NewAgentTune.tsx', 'nodes/TuneMenu.tsx']) {
      expect(src(file)).toContain('keyboardCoverNow()')
      expect(src(file)).not.toMatch(/bottom: window\.innerHeight - r\.top/)
    }
  })
})

describe('each pick puts the caret in the box', () => {
  const box = src('prompt/GlobalPrompt.tsx')
  const between = (from: string, to: string): string => {
    const start = box.indexOf(from)
    expect(start).toBeGreaterThan(-1)
    return box.slice(start, box.indexOf(to, start))
  }

  it('focuses the prompt input', () => {
    expect(box).toContain('const focusBox = (): void => inputRef.current?.focus()')
  })

  it('after the harness is picked', () => {
    expect(between('const pick = (name: string): void => {', '\n  }\n')).toContain('focusBox()')
  })

  it("after the new agent's model or effort is picked", () => {
    expect(between('<NewAgentTune', '/>')).toMatch(/pickLaunch\(knob, value\)\s*\n\s*focusBox\(\)/)
  })

  it("after the agent's own model, effort or route is turned", () => {
    expect(between('<CardTune key=', '/>')).toContain('onTurned={focusBox}')
    const tune = src('nodes/CardTune.tsx')
    expect(tune).toMatch(/tuning\.turn\(knob, value\)\s*\n\s*onTurned\?\.\(\)/)
    expect(tune).toMatch(/cardRoute\.pick\(route\)\s*\n\s*onTurned\?\.\(\)/)
  })

  it("lets a menu's Esc close only the menu, not the box's caret", () => {
    expect(between('const close = (e: Event): void => {', 'setPicking(null)')).toContain('e.stopPropagation()')
    expect(src('prompt/NewAgentTune.tsx')).toMatch(/if \(e\.key === 'Escape'\) \{\s*\n\s*\/\/[^\n]*\n\s*e\.stopPropagation\(\)/)
  })
})

describe('typing the prompt closes a tune menu still open over the box', () => {
  const box = { matches: (sel: string) => sel === '.cr-prompt input[type=text]' }
  const elsewhere = { matches: () => false }

  it('reads a key typed into the box', () => {
    for (const key of ['a', ' ', 'Enter', 'Backspace', 'Delete']) expect(typesIntoBox({ key, target: box })).toBe(true)
  })

  it('leaves Esc, arrows, modifiers and an IME mid-word to the menu', () => {
    for (const key of ['Escape', 'ArrowDown', 'Shift', 'Meta', 'Process']) expect(typesIntoBox({ key, target: box })).toBe(false)
  })

  it('reads no key typed anywhere else', () => {
    expect(typesIntoBox({ key: 'a', target: elsewhere })).toBe(false)
    expect(typesIntoBox({ key: 'a', target: null })).toBe(false)
    expect(typesIntoBox({ key: 'a', target: {} })).toBe(false)
  })

  it('in both tune menus, and only when the agent panel rises over the box', () => {
    expect(src('prompt/NewAgentTune.tsx')).toContain('} else if (!typesIntoBox(e)) return')
    expect(src('nodes/TuneMenu.tsx')).toContain('if (rise && typesIntoBox(e)) return close()')
  })
})
