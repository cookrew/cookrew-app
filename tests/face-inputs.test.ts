// FACE INPUTS & FOLLOW-UP (task card "Task · Face inputs & follow-up",
// 2026-11-04; design docs/avatar-send-design-2026-11-04.html). Behaviour, not
// source: real events on a stand-in window, a stand-in history, and the fold
// store the box and the zoom both read.
//
//   1. a file dropped or a picture pasted on the folded ＋ face opens the box with it attached
//   2. Android back (the companion's back): the picker, then the box, then the zoom
//   3. after a prompt makes an agent, the box follows it until the zoom's next deliberate move
//   4. the fold: Enter in an empty box, an outside press, the Esc order, select/deselect
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boxFold, promptFold, takeBack } from '../src/renderer/src/prompt/prompt-fold'
import { backHolder, listenBack, type HistoryLike } from '../src/renderer/src/prompt/back-guard'
import { listenFoldPress } from '../src/renderer/src/prompt/fold-press'
import { sendPlan } from '../src/renderer/src/prompt/send-plan'
import { pasteOpensBox } from '../src/renderer/src/prompt/enter-opens'
import { boxTargetId, pickAfterMove, pickNow } from '../src/renderer/src/prompt/prompt-target'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')

/** A stand-in element: `closest` answers for the selectors it is inside. */
const el = (...inside: string[]): Element =>
  ({ closest: (sel: string) => (sel.split(',').some((s) => inside.includes(s.trim())) ? ({} as Element) : null) }) as unknown as Element

/** A pointer event on `target`, as the window's capture listener sees it. */
const press = (type: string, target: Element | null, init: { button?: number; isPrimary?: boolean } = {}): Event => {
  const e = new Event(type, { cancelable: true })
  Object.defineProperty(e, 'target', { value: target })
  return Object.assign(e, { button: init.button ?? 0, isPrimary: init.isPrimary ?? true })
}

/** The fold store as the box leaves it: nobody in the box, folded, its face on the bar. */
const reset = (): void => {
  promptFold.setPicker(false)
  promptFold.fold()
  promptFold.setFoldable(true)
}

describe('4 · Enter in an empty box sends nothing', () => {
  const to = { id: 'a' }
  it('nobody in the box: no words, or only spaces, make no agent', () => {
    expect(sendPlan({ text: '', to: null, fullAgentId: null, mention: null })).toEqual({ kind: 'none' })
    expect(sendPlan({ text: '   ', to: null, fullAgentId: null, mention: null })).toEqual({ kind: 'none' })
  })
  it("an agent's card: no words send nothing (a bare Enter could answer a prompt nobody sees)", () => {
    expect(sendPlan({ text: '', to, fullAgentId: null, mention: null })).toEqual({ kind: 'none' })
    expect(sendPlan({ text: ' ', to, fullAgentId: 'other', mention: null })).toEqual({ kind: 'none' })
  })
  it('"@Other" with no words after it sends nothing', () => {
    expect(sendPlan({ text: '@Bo', to, fullAgentId: null, mention: { id: 'b', text: '' } })).toEqual({ kind: 'none' })
  })
  it("the one exception, as today: in the agent's own full view a bare Enter goes to its terminal", () => {
    expect(sendPlan({ text: '', to, fullAgentId: 'a', mention: null })).toEqual({ kind: 'agent', id: 'a', words: '' })
  })
  it('words go where the box points, or to the agent named', () => {
    expect(sendPlan({ text: 'fix it', to: null, fullAgentId: null, mention: null })).toEqual({ kind: 'new', words: 'fix it' })
    expect(sendPlan({ text: 'go on', to, fullAgentId: null, mention: null })).toEqual({ kind: 'agent', id: 'a', words: 'go on' })
    expect(sendPlan({ text: '@Bo look', to, fullAgentId: null, mention: { id: 'b', text: 'look' } })).toEqual({ kind: 'mention', id: 'b', words: 'look' })
    expect(sendPlan({ text: '@A look', to, fullAgentId: null, mention: { id: 'a', text: 'look' } })).toEqual({ kind: 'agent', id: 'a', words: 'look' })
  })
})

describe('4 · an outside press folds the box', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const setup = (): { win: EventTarget; onFold: ReturnType<typeof vi.fn>; stop: () => void } => {
    const win = new EventTarget()
    const onFold = vi.fn()
    const stop = listenFoldPress(win, { onFold })
    return { win, onFold, stop }
  }
  const click = (): Event => new Event('click', { cancelable: true })

  it('a press on the canvas folds and swallows exactly one click: its own', () => {
    const { win, onFold } = setup()
    const down = press('pointerdown', el('.zv-overview'))
    win.dispatchEvent(down)
    expect(onFold).toHaveBeenCalledTimes(1)
    win.dispatchEvent(press('pointerup', el('.zv-overview')))
    const first = click()
    win.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    const second = click()
    win.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
  })

  it("a finger's slow click still counts as the press's own; after the grace nothing is swallowed", () => {
    const { win } = setup()
    win.dispatchEvent(press('pointerdown', el('.zv-overview')))
    win.dispatchEvent(press('pointerup', el('.zv-overview')))
    vi.advanceTimersByTime(200)
    const late = click()
    win.dispatchEvent(late)
    expect(late.defaultPrevented).toBe(true)

    win.dispatchEvent(press('pointerdown', el('.zv-overview')))
    win.dispatchEvent(press('pointerup', el('.zv-overview')))
    vi.advanceTimersByTime(1000)
    const stale = click()
    win.dispatchEvent(stale)
    expect(stale.defaultPrevented).toBe(false)
  })

  it('a press that became a pan clicks nothing, so nothing is left armed', () => {
    const { win } = setup()
    win.dispatchEvent(press('pointerdown', el('.zv-overview')))
    win.dispatchEvent(press('pointercancel', el('.zv-overview')))
    const next = click()
    win.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
  })

  it('elsewhere (the header, a dialog over the canvas) it folds and the press goes on to do its own thing', () => {
    const { win, onFold } = setup()
    for (const target of [el('.cr-header'), el('.zv-overview', '[role="dialog"]')]) {
      win.dispatchEvent(press('pointerdown', target))
      win.dispatchEvent(press('pointerup', target))
      const c = click()
      win.dispatchEvent(c)
      expect(c.defaultPrevented).toBe(false)
    }
    expect(onFold).toHaveBeenCalledTimes(2)
  })

  it('the box, its menus, its face and the picker keep it open; so do a secondary button and a second finger', () => {
    const { win, onFold } = setup()
    for (const sel of ['.cr-prompt', '.cr-prompt-menu', '.cr-tune-menu', '.pf-face', '.pf-who']) win.dispatchEvent(press('pointerdown', el(sel)))
    win.dispatchEvent(press('pointerdown', el('.zv-overview'), { button: 2 }))
    win.dispatchEvent(press('pointerdown', el('.zv-overview'), { isPrimary: false }))
    expect(onFold).not.toHaveBeenCalled()
  })

  it('unlistening leaves nothing behind', () => {
    const { win, onFold, stop } = setup()
    stop()
    win.dispatchEvent(press('pointerdown', el('.zv-overview')))
    expect(onFold).not.toHaveBeenCalled()
  })
})

describe('4 · the Esc order: picker, then box, then zoom', () => {
  beforeEach(reset)

  it('each press takes one step, and only the last reaches the zoom', () => {
    const zoomOut = vi.fn(() => true)
    promptFold.open()
    promptFold.setPicker(true)
    expect(takeBack(zoomOut)).toBe(true)
    expect(promptFold.get()).toMatchObject({ picker: false, open: true })
    expect(takeBack(zoomOut)).toBe(true)
    expect(promptFold.get()).toMatchObject({ picker: false, open: false })
    expect(zoomOut).not.toHaveBeenCalled()
    expect(takeBack(zoomOut)).toBe(true)
    expect(zoomOut).toHaveBeenCalledTimes(1)
  })

  it('an agent in the box (it cannot fold): the picker closes, then the zoom steps out', () => {
    const zoomOut = vi.fn(() => true)
    promptFold.setFoldable(false)
    promptFold.setPicker(true)
    expect(takeBack(zoomOut)).toBe(true)
    expect(zoomOut).not.toHaveBeenCalled()
    takeBack(zoomOut)
    expect(zoomOut).toHaveBeenCalledTimes(1)
  })

  it('at the outermost stop nothing is left to take', () => {
    expect(takeBack(() => false)).toBe(false)
  })

  it('folding closes the picker with the box', () => {
    promptFold.open()
    promptFold.setPicker(true)
    promptFold.fold()
    expect(promptFold.get().picker).toBe(false)
  })
})

describe('4 · an agent selected opens the box; deselecting folds it', () => {
  beforeEach(reset)
  /** The box as the bar draws it, from the store and whether an agent is in it. */
  const box = (pinned: boolean): ReturnType<typeof boxFold> => {
    promptFold.setFoldable(!pinned)
    return boxFold({ place: 'bar', slot: true, pinned, open: promptFold.get().open })
  }

  it('selected: open in the bar\'s place; deselected: folded back to the face', () => {
    expect(box(false)).toMatchObject({ folded: true })
    expect(box(true)).toMatchObject({ folded: false, overBar: true })
    expect(box(false)).toMatchObject({ folded: true, overBar: false })
  })

  it('a box opened for nobody is not left open behind a selected agent', () => {
    promptFold.open()
    expect(box(true)).toMatchObject({ folded: false })
    expect(box(false)).toMatchObject({ folded: true })
  })

  it('back while an agent is selected steps out (closing its card), never folds what cannot fold', () => {
    box(true)
    expect(promptFold.wantsBack()).toBe(false)
    promptFold.setFoldable(true)
    promptFold.open()
    expect(promptFold.wantsBack()).toBe(true)
  })
})

/** A browser history: entries, a cursor, and popstate dispatched on `win` a task later, as a browser does. */
function fakeHistory(win: EventTarget): HistoryLike & { entries: unknown[]; at: number; flush: () => void; userBack: () => void } {
  const queue: (() => void)[] = []
  const h = {
    entries: [null] as unknown[],
    at: 0,
    get state(): unknown {
      return h.entries[h.at]
    },
    pushState(data: unknown): void {
      h.entries = [...h.entries.slice(0, h.at + 1), data]
      h.at += 1
    },
    back(): void {
      queue.push(() => {
        if (h.at === 0) return
        h.at -= 1
        win.dispatchEvent(new Event('popstate'))
      })
    },
    flush(): void {
      while (queue.length) queue.shift()!()
    },
    userBack(): void {
      h.back()
      h.flush()
    }
  }
  return h
}

describe('2 · Android back: one history entry, pushed on open, popped on fold', () => {
  const setup = (wants: { now: boolean }) => {
    const win = new EventTarget()
    const history = fakeHistory(win)
    const back = vi.fn()
    const guard = listenBack(win, history, { wants: () => wants.now, back })
    return { win, history, back, guard }
  }

  it('opening pushes one entry; a fold by Esc or a press pops it: no stray entries', () => {
    const wants = { now: false }
    const { history, guard } = setup(wants)
    guard.sync()
    expect(history.entries).toHaveLength(1)
    wants.now = true
    guard.sync()
    guard.sync()
    expect(history.entries).toHaveLength(2)
    expect(history.at).toBe(1)
    wants.now = false
    guard.sync()
    history.flush()
    expect(history.at).toBe(0)
  })

  it('back takes the step and, while more is left, keeps one entry to take the next', () => {
    const wants = { now: true }
    const { history, back, guard } = setup(wants)
    guard.sync()
    history.userBack()
    expect(back).toHaveBeenCalledTimes(1)
    expect(history.at).toBe(1)
    wants.now = false
    history.userBack()
    expect(back).toHaveBeenCalledTimes(1)
    expect(history.at).toBe(0)
  })

  it('back leaves the page only when nothing is left to fold or step out of', () => {
    const wants = { now: true }
    const { history, back, guard } = setup(wants)
    guard.sync()
    back.mockImplementation(() => {
      wants.now = false
    })
    history.userBack()
    expect(back).toHaveBeenCalledTimes(1)
    expect(history.at).toBe(0)
    expect(history.entries.filter((s) => s !== null && typeof s === 'object')).toHaveLength(1)
  })

  it('never pops twice while its own back is on its way (a quick fold, open, fold)', () => {
    const wants = { now: true }
    const { history, back, guard } = setup(wants)
    guard.sync()
    wants.now = false
    guard.sync()
    guard.sync()
    wants.now = true
    guard.sync()
    history.flush()
    expect(back).not.toHaveBeenCalled()
    expect(history.at).toBe(1)
  })

  it('a reload on its own entry takes it back as its own', () => {
    const win = new EventTarget()
    const history = fakeHistory(win)
    const first = listenBack(win, history, { wants: () => true, back: () => undefined })
    first.sync()
    first.stop()
    const second = listenBack(win, history, { wants: () => false, back: () => undefined })
    second.sync()
    history.flush()
    expect(history.at).toBe(0)
  })

  it('unlistening stops taking backs', () => {
    const wants = { now: true }
    const { history, back, guard } = setup(wants)
    guard.sync()
    guard.stop()
    history.userBack()
    expect(back).not.toHaveBeenCalled()
  })
})

describe('2 · the zoom holds the guard while it is mounted', () => {
  it('a remount (StrictMode, or the view coming back) never reads its own pop as a back', () => {
    const win = new EventTarget()
    const history = fakeHistory(win)
    const holder = backHolder(win, history)
    const back = vi.fn()
    const layers = { wants: () => true, back }
    holder.hold(layers)()
    holder.hold(layers)
    history.flush()
    expect(back).not.toHaveBeenCalled()
    expect(history.at).toBe(1)
    history.userBack()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('unmounted for good, it takes its entry with it', () => {
    const win = new EventTarget()
    const history = fakeHistory(win)
    const release = backHolder(win, history).hold({ wants: () => true, back: () => undefined })
    expect(history.at).toBe(1)
    release()
    history.flush()
    expect(history.at).toBe(0)
  })

  it('one holder per window', () => {
    const win = new EventTarget()
    const history = fakeHistory(win)
    expect(backHolder(win, history)).toBe(backHolder(win, history))
  })
})

describe('1 · a picture pasted with the box folded', () => {
  it('opens it from the page, the canvas or a button', () => {
    expect(pasteOpensBox(null)).toBe(true)
    expect(pasteOpensBox(el('.zv-overview'))).toBe(true)
    expect(pasteOpensBox(el('button'))).toBe(true)
  })
  it('never from a field, a terminal, a note being written or a dialog', () => {
    for (const sel of ['input', 'textarea', '[contenteditable="true"]', '.xterm', '[role="dialog"]', '[aria-modal="true"]']) expect(pasteOpensBox(el(sel))).toBe(false)
  })
})

describe('1 · the folded face takes a dropped file', () => {
  it('the face is a drop zone that opens the box, with the drop cue over the face', () => {
    const box = read('prompt', 'GlobalPrompt.tsx')
    expect(box).toMatch(/useDropOn\(folded \? faceEl : null/)
    expect(read('prompt', 'PromptFace.tsx')).toMatch(/pf-drop-cue/)
    expect(read('prompt', 'prompt-face.css')).toMatch(/\.pf-face\.pf-dropping \.pf-drop-cue \{/)
  })
})

describe('3 · after a prompt makes an agent, the box follows it', () => {
  const known = (id: string): boolean => ['a', 'new'].includes(id)
  it('the made agent stands in for the view until the zoom\'s next deliberate move', () => {
    const made = { id: 'new', at: 'agents|2|new||0' }
    expect(pickNow(made, 'agents|2|new||0')).toBe('new')
    expect(boxTargetId({ viewed: null, pin: null, released: null, known, picked: pickNow(made, 'agents|2|new||0') })).toBe('new')
    expect(pickNow(made, 'agents|1|new||0')).toBeNull()
    expect(boxTargetId({ viewed: null, pin: null, released: null, known, picked: pickNow(made, 'agents|1|new||0') })).toBeNull()
  })
  it('a pick made before the crew knows the agent waits for it, then takes the box', () => {
    const made = { id: 'new', at: 'k' }
    const before = (id: string): boolean => id === 'a'
    expect(boxTargetId({ viewed: null, pin: null, released: null, known: before, picked: pickNow(made, 'k') })).toBeNull()
    expect(boxTargetId({ viewed: null, pin: null, released: null, known, picked: pickNow(made, 'k') })).toBe('new')
  })
  it('a move ends it for good: the zoom back where it was (a card closed and opened again) does not bring it back', () => {
    const made = { id: 'new', at: 'agents|2|a||0' }
    const kept = pickAfterMove(made, 'agents|2|a||0')
    expect(kept).toBe(made)
    const moved = pickAfterMove(kept, 'agents|1|a||0')
    expect(moved).toBeNull()
    expect(pickNow(moved, 'agents|2|a||0')).toBeNull()
  })
  it('no pick, no stand-in', () => {
    expect(pickNow(null, 'k')).toBeNull()
  })
})
