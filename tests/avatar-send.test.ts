// THE FACE IS THE SEND KEY (owner, 2026-11-04): the bar stays, the box folds
// into the target agent's face at its right end; a tap or Enter (no field
// focused) opens it; in a browser's or note's full view the face is the
// item's latest user. Pure rules here; the CSS contract below.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxFold, facePlace, promptFold } from '../src/renderer/src/prompt/prompt-fold'
import { clipFrom, flipFrom } from '../src/renderer/src/prompt/face-flip'
import { enterOpensBox, keepsBoxOpen, pressOnCanvas } from '../src/renderer/src/prompt/enter-opens'
import { latestUser, pickerRows } from '../src/renderer/src/prompt/item-user'
import { boxTargetId } from '../src/renderer/src/prompt/prompt-target'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')

/** A stand-in element: `closest` answers for the selectors it is inside. */
const el = (...inside: string[]): Element =>
  ({ closest: (sel: string) => (sel.split(',').some((s) => inside.includes(s.trim())) ? ({} as Element) : null) }) as unknown as Element

describe('where the folded face stands', () => {
  it('on the bar at the zoom stops, alone in the corner over an item, nowhere in an agent full view', () => {
    expect(facePlace(null)).toBe('bar')
    expect(facePlace('item')).toBe('corner')
    expect(facePlace('agent')).toBe('none')
  })
})

describe('an agent selected opens the box (owner, 2026-11-04)', () => {
  it('nobody in the box: it folds at the bar, open only when opened', () => {
    expect(boxFold({ place: 'bar', slot: true, pinned: false, open: false })).toEqual({ canFold: true, folded: true, overBar: false })
    expect(boxFold({ place: 'bar', slot: true, pinned: false, open: true })).toEqual({ canFold: true, folded: false, overBar: true })
  })
  it('an agent in the box: open at once, in the bar\'s place, and no fold', () => {
    expect(boxFold({ place: 'bar', slot: true, pinned: true, open: false })).toEqual({ canFold: false, folded: false, overBar: true })
    expect(boxFold({ place: 'corner', slot: false, pinned: true, open: false })).toEqual({ canFold: false, folded: false, overBar: false })
  })
  it('no bar mounted (the board) and an agent full view never fold', () => {
    expect(boxFold({ place: 'bar', slot: false, pinned: false, open: false }).folded).toBe(false)
    expect(boxFold({ place: 'none', slot: true, pinned: false, open: false }).folded).toBe(false)
  })
})

describe('the face flies to the left', () => {
  it('is drawn from the folded face: corner to corner, scaled by width', () => {
    expect(flipFrom({ left: 310, top: 740, width: 34, height: 34 }, { left: 16, top: 744, width: 28, height: 28 })).toEqual({ dx: 294, dy: -4, s: 34 / 28 })
  })
  it('the box opens leftward from the folded face, never cutting it', () => {
    expect(clipFrom({ left: 312, top: 0, width: 34, height: 34 }, { left: 8, top: 0, width: 344, height: 48 })).toBe(300)
    expect(clipFrom({ left: 2000, top: 0, width: 34, height: 34 }, { left: 8, top: 0, width: 344, height: 48 })).toBe(344)
    expect(clipFrom({ left: 0, top: 0, width: 34, height: 34 }, { left: 8, top: 0, width: 344, height: 48 })).toBe(0)
  })
  it('does nothing without a size to fly from or to', () => {
    expect(flipFrom({ left: 0, top: 0, width: 0, height: 0 }, { left: 16, top: 744, width: 28, height: 28 })).toBeNull()
  })
})

describe('the fold store', () => {
  it('Esc folds first only an open box that can fold', () => {
    promptFold.setFoldable(false)
    promptFold.open()
    expect(promptFold.foldFirst()).toBe(false)
    promptFold.setFoldable(true)
    expect(promptFold.foldFirst()).toBe(true)
    expect(promptFold.get().open).toBe(false)
    expect(promptFold.foldFirst()).toBe(false)
  })

  it('tells its readers once per change', () => {
    let calls = 0
    const off = promptFold.subscribe(() => calls++)
    promptFold.open()
    promptFold.open()
    promptFold.fold()
    off()
    expect(calls).toBe(2)
  })
})

describe('Enter opens the folded box', () => {
  it('a bare Enter on the page opens it', () => {
    expect(enterOpensBox({ key: 'Enter' }, el())).toBe(true)
    expect(enterOpensBox({ key: 'Enter' }, null)).toBe(true)
  })

  it('never from a field, a terminal, a button, a link, a menu row or a dialog', () => {
    for (const sel of ['input', 'textarea', 'button', 'a[href]', '[role="option"]', '[role="dialog"]', '.xterm', '[contenteditable="true"]']) {
      expect(enterOpensBox({ key: 'Enter' }, el(sel))).toBe(false)
    }
  })

  it('never a held, composed or chorded Enter, nor another key', () => {
    expect(enterOpensBox({ key: 'Enter', repeat: true }, el())).toBe(false)
    expect(enterOpensBox({ key: 'Enter', isComposing: true }, el())).toBe(false)
    expect(enterOpensBox({ key: 'Enter', metaKey: true }, el())).toBe(false)
    expect(enterOpensBox({ key: 'Enter', shiftKey: true }, el())).toBe(false)
    expect(enterOpensBox({ key: 'a' }, el())).toBe(false)
  })

  it('a press in the box, its menus, its face or the picker keeps it open; anywhere else folds', () => {
    for (const sel of ['.cr-prompt', '.cr-prompt-menu', '.cr-tune-menu', '.pf-face', '.pf-who']) expect(keepsBoxOpen(el(sel))).toBe(true)
    expect(keepsBoxOpen(el('.zv-overview'))).toBe(false)
    expect(keepsBoxOpen(null)).toBe(false)
  })

  it('the press that folds does nothing else only on the canvas, never in a dialog', () => {
    expect(pressOnCanvas(el('.zv-overview'))).toBe(true)
    expect(pressOnCanvas(el('.zv-overview', '[role="dialog"]'))).toBe(false)
    expect(pressOnCanvas(el('.cr-header'))).toBe(false)
    expect(pressOnCanvas(null)).toBe(false)
  })

  it('an Enter something nearer already took opens nothing', () => {
    expect(enterOpensBox({ key: 'Enter', defaultPrevented: true }, el())).toBe(false)
  })
})

describe("an item's latest user", () => {
  const rows = [
    { id: 'a', lastActivityAt: 10 },
    { id: 'b', lastActivityAt: 30 },
    { id: 'c', lastActivityAt: 20 }
  ]
  it('is the wired agent active last', () => {
    expect(latestUser(['a', 'c'], rows)).toBe('c')
    expect(latestUser(['a', 'b', 'c'], rows)).toBe('b')
  })
  it('is nobody when none is wired or known', () => {
    expect(latestUser([], rows)).toBeNull()
    expect(latestUser(['gone'], rows)).toBeNull()
  })
})

describe('the who-picker', () => {
  const r = (id: string, status: string, at: number) => ({ id, name: id, status, lastActivityAt: at })
  const rows = [r('w', 'waiting', 1), r('x', 'idle', 50), r('y', 'working', 90), r('z', 'idle', 70), r('cur', 'idle', 99)]
  it('puts who waits first, then the most recent, the one in the box where it stands (cut 2026-11-04)', () => {
    const out = pickerRows(rows, { current: 'cur', recent: 2 })
    expect(out.waiting.map((x) => x.id)).toEqual(['w'])
    expect(out.recent.map((x) => x.id)).toEqual(['cur', 'y'])
  })
  it("leads with an item's users in its full view", () => {
    expect(pickerRows(rows, { current: null, first: ['x'], recent: 2 }).recent.map((x) => x.id)).toEqual(['x', 'cur'])
  })
})

describe('a pick stands in for the view', () => {
  const known = (id: string): boolean => ['a', 'b'].includes(id)
  it('until words pin the box elsewhere', () => {
    expect(boxTargetId({ viewed: 'a', pin: null, released: null, known, picked: 'b' })).toBe('b')
    expect(boxTargetId({ viewed: 'a', pin: { id: 'a' }, released: null, known, picked: 'b' })).toBe('a')
  })
  it('an unknown pick is ignored, and a release still lets go', () => {
    expect(boxTargetId({ viewed: 'a', pin: null, released: null, known, picked: 'gone' })).toBe('a')
    expect(boxTargetId({ viewed: 'a', pin: null, released: { id: 'b', viewed: 'a' }, known, picked: 'b' })).toBeNull()
  })
})

describe('the CSS contract', () => {
  const face = read('prompt', 'prompt-face.css')
  it('folded: the box is hidden and the bar comes down to its own foot', () => {
    expect(face).toMatch(/body\.cr-prompt-folded[^{]*\.cr-prompt \{[^}]*display: none/)
    expect(face).toMatch(/body\.cr-prompt-folded:not\(\.cr-prompt-corner\) \.cr-app\.cr-app:not\(\.cr-embed\) \{[^}]*--cr-float-h:/)
  })
  it("over a browser or a note the sheet keeps its foot (no resize, no face on the page's controls)", () => {
    expect(face).not.toMatch(/body\.cr-prompt-folded \.cr-app\.cr-app/)
  })
  it('open at the stops: the bar steps aside for the box', () => {
    expect(face).toMatch(/body\.cr-prompt-open \.zv-root:not\(\[data-full='true'\]\) \.zv-controls \{[^}]*opacity: 0;[^}]*pointer-events: none/)
  })
  it("a phone's card drops its own reply box (the face is the one place to type)", () => {
    expect(face).toMatch(/body\.cookrew-mobile:is\(\.cr-prompt-folded, \.cr-prompt-open\) \.zv-reply:not\(\.cr-pet-card-ask\) \{[^}]*display: none !important/)
  })
  it('the chip is the face and Send is the box\'s own button again', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    expect(box).toMatch(/className="cr-prompt-to pf-chip"/)
    expect(box).toMatch(/<button type="submit" className="cr-btn sm primary"[^>]*aria-label="Send"/)
    expect(face).toMatch(/\.pf-chip-face \{[^}]*transform-origin: 0 0/)
  })
  it('the zoom bar keeps the slot and asks the box before Esc steps out', () => {
    const zoom = read('zoom', 'ZoomView.tsx')
    expect(zoom).toMatch(/ref=\{setFaceSlot\}/)
    expect(zoom).toMatch(/promptFold\.foldFirst\(\)/)
  })
})
