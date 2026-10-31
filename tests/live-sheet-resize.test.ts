// A NEW WIDTH ENDS THE SNAPSHOT (live-sheet.ts): the phone turned while the
// reader was up in the history, and the copy they were reading was wrapped at
// the old width — the surface leaves it, goes to the bottom and renders again.
// A new height alone (a toolbar sliding away) leaves the reader where they are.
//
// There is no DOM in this suite's environment, so the few elements the sheet
// moves are faked here, enough to drive its touch and resize handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHEET_REFRESH_MS, installLiveSheet, type SheetTerminal } from '../src/renderer/src/live-sheet'

type Handler = (e?: unknown) => void

function fakeElement() {
  const handlers = new Map<string, Handler>()
  const classes = new Set<string>()
  const el = {
    className: '',
    type: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 600,
    style: { setProperty: () => undefined } as Record<string, unknown>,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c)
    },
    setAttribute: () => undefined,
    append: () => undefined,
    appendChild: () => undefined,
    remove: () => undefined,
    insertAdjacentHTML: () => undefined,
    scrollTo: () => undefined,
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }),
    querySelector: () => null as unknown,
    fire: (type: string) => handlers.get(type)?.()
  }
  return el
}

function fakeTerm(cols: number) {
  let resized: (() => void) | null = null
  const screen = fakeElement()
  screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: cols * 8, height: 600 })
  const element = fakeElement()
  element.querySelector = () => screen
  const term = {
    cols,
    rows: 30,
    element,
    options: { theme: {}, scrollback: 5000 },
    buffer: { active: { type: 'normal', baseY: 300, viewportY: 300, getLine: () => undefined } },
    onWriteParsed: () => ({ dispose: () => undefined }),
    onResize: (fn: () => void) => {
      resized = fn
      return { dispose: () => undefined }
    },
    focus: () => undefined
  }
  const resize = (nextCols: number, nextRows: number) => {
    term.cols = nextCols
    term.rows = nextRows
    resized?.()
  }
  return { term: term as unknown as SheetTerminal, resize }
}

let made: ReturnType<typeof fakeElement>[] = []

beforeEach(() => {
  vi.useFakeTimers()
  made = []
  vi.stubGlobal('document', {
    createElement: () => {
      const el = fakeElement()
      made.push(el)
      return el
    }
  })
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '13px', fontFamily: 'mono', letterSpacing: '0', fontWeight: '400' }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The sheet up, rendered, and the reader's finger scrolling it into the history. */
function scrolledUp(cols: number) {
  const f = fakeTerm(cols)
  const container = fakeElement()
  const sheetApi = installLiveSheet(f.term, container as unknown as HTMLElement, { live: () => true, wantHistory: () => undefined })
  const [sheet, , , , down] = made // sheet, hist, spacer, snap, down — in the order the sheet makes them
  vi.advanceTimersByTime(SHEET_REFRESH_MS)
  sheet.fire('touchstart')
  sheet.scrollTop = 400 // up in the history
  sheet.fire('touchend')
  vi.advanceTimersByTime(200)
  return { f, sheet, down, sheetApi }
}

describe('the live sheet and a new width', () => {
  it('reading a snapshot, the phone turns: the copy comes off and the surface is back at the bottom', () => {
    const { f, sheet, down, sheetApi } = scrolledUp(49)
    expect(sheet.classList.contains('armed')).toBe(true)
    expect(down.classList.contains('on')).toBe(true)
    f.resize(99, 22)
    expect(sheet.classList.contains('armed')).toBe(false)
    expect(down.classList.contains('on')).toBe(false)
    expect(sheet.scrollTop).toBe(sheet.scrollHeight)
    sheetApi.dispose()
  })

  it('a new height alone keeps the reader where they are', () => {
    const { f, sheet, down, sheetApi } = scrolledUp(49)
    f.resize(49, 26) // the toolbar slid away
    expect(sheet.classList.contains('armed')).toBe(true)
    expect(down.classList.contains('on')).toBe(true)
    expect(sheet.scrollTop).toBe(400)
    sheetApi.dispose()
  })
})
