// THIS LINUX MACHINE'S WINDOWS (main/linux-windows.ts): X11 facts read through
// xdotool (and xprop when it is there), with no window manager needed, joined
// into the rows the picker shows and the one window a card is bound to.
import { describe, expect, it, vi } from 'vitest'
import {
  findX11Window,
  listX11Windows,
  lookupX11Window,
  parseGeometry,
  parseIds,
  parseWmClass,
  windowFocusCalls,
  type X11Deps,
  type X11Window
} from '../src/main/linux-windows'

/** A fake X server: what each xdotool / xprop argv prints, or throws. */
function fakeX(windows: Array<{ id: number; title: string; x: number; y: number; width: number; height: number; pid?: number; cls?: string; hidden?: boolean }>, more: Partial<X11Deps> = {}) {
  const xdotool = vi.fn(async (argv: readonly string[]): Promise<string> => {
    if (argv[0] === 'search') {
      const shown = windows.filter((w) => !w.hidden && w.title !== '')
      if (shown.length === 0) throw Object.assign(new Error('xdotool exited 1'), { code: 1, stdout: '' })
      return shown.map((w) => `${w.id}\n`).join('')
    }
    const id = Number(argv[1])
    const w = windows.find((candidate) => candidate.id === id)
    if (!w) throw new Error(`X Error of failed request:  BadWindow (invalid Window parameter)`)
    if (argv[0] === 'getwindowname') return `${w.title}\nWINDOW=${w.id}\nX=${w.x}\nY=${w.y}\nWIDTH=${w.width}\nHEIGHT=${w.height}\nSCREEN=0\n`
    if (argv[0] === 'getwindowpid') {
      if (w.pid === undefined) throw new Error(`window ${w.id} has no pid associated with it.`)
      return `${w.pid}\n`
    }
    throw new Error(`unexpected ${argv.join(' ')}`)
  })
  const xprop = vi.fn(async (argv: readonly string[]): Promise<string> => {
    const w = windows.find((candidate) => candidate.id === Number(argv[1]))
    return w?.cls ? `WM_CLASS(STRING) = "${w.cls.toLowerCase()}", "${w.cls}"\n` : 'WM_CLASS:  not found.\n'
  })
  const deps: X11Deps = { xdotool, xprop, comm: (pid) => (pid === 4680 ? 'bash' : null), selfPid: 999, ...more }
  return { deps, xdotool, xprop }
}

const term = { id: 4194316, title: 'term one', x: 50, y: 60, width: 484, height: 264, pid: 4680, cls: 'XTerm' }
const eyes = { id: 2097162, title: 'xeyes', x: 700, y: 100, width: 200, height: 150, cls: 'XEyes' }
const self = { id: 6291459, title: 'Cookrew', x: 0, y: 0, width: 1280, height: 800, pid: 999, cls: 'Cookrew' }

describe('parsers', () => {
  it('ids: one decimal per line, junk ignored', () => {
    expect(parseIds('4194316\n2097162\n\nnot-an-id\n')).toEqual([4194316, 2097162])
  })

  it('geometry: the --shell lines after the title; a title may hold anything, even WIDTH=1', () => {
    expect(parseGeometry('WIDTH=1 tricky title\nWINDOW=7\nX=-5\nY=60\nWIDTH=484\nHEIGHT=264\nSCREEN=0\n')).toEqual({ title: 'WIDTH=1 tricky title', x: -5, y: 60, width: 484, height: 264 })
    expect(parseGeometry('garbage')).toBeNull()
  })

  it('WM_CLASS: the class, the second string', () => {
    expect(parseWmClass('WM_CLASS(STRING) = "xterm", "XTerm"')).toBe('XTerm')
    expect(parseWmClass('WM_CLASS(STRING) = "google-chrome", "Google-chrome"')).toBe('Google-chrome')
    expect(parseWmClass('WM_CLASS:  not found.')).toBeNull()
  })
})

describe('listX11Windows', () => {
  it('lists every shown, titled window with its app, title, pid and place, Cookrew left out', async () => {
    const { deps } = fakeX([term, eyes, self])
    const list = await listX11Windows(deps)
    expect(list).toEqual([
      { id: 4194316, title: 'term one', app: 'XTerm', pid: 4680, x: 50, y: 60, width: 484, height: 264 },
      { id: 2097162, title: 'xeyes', app: 'XEyes', pid: null, x: 700, y: 100, width: 200, height: 150 }
    ])
  })

  it('searches without asking for a window manager: shown windows with a title, at any depth', async () => {
    const { deps, xdotool } = fakeX([term])
    await listX11Windows(deps)
    expect(xdotool).toHaveBeenCalledWith(['search', '--onlyvisible', '--name', '.'])
  })

  it('no xprop: the app is the process name, else the title', async () => {
    const { deps } = fakeX([term, eyes], { xprop: null })
    const list = await listX11Windows(deps)
    expect(list.map((w) => w.app)).toEqual(['bash', 'xeyes'])
  })

  it('nothing shown is an empty list, not an error (xdotool exits 1)', async () => {
    expect(await listX11Windows(fakeX([]).deps)).toEqual([])
  })

  it('a window that closes between the search and its facts is simply not listed', async () => {
    const { deps, xdotool } = fakeX([term, eyes])
    const real = xdotool.getMockImplementation()!
    xdotool.mockImplementation(async (argv) => (argv[0] === 'getwindowname' && argv[1] === String(eyes.id) ? Promise.reject(new Error('BadWindow')) : real(argv)))
    expect((await listX11Windows(deps)).map((w) => w.id)).toEqual([term.id])
  })

  it('a frame with the same title around its client is one row, the client', async () => {
    const frame = { ...term, id: 111, x: 48, y: 40, width: 488, height: 286, pid: undefined, cls: undefined }
    const { deps } = fakeX([frame, term])
    expect((await listX11Windows(deps)).map((w) => w.id)).toEqual([term.id])
  })

  it('tiny windows (a 1x1 helper) are not things to pick', async () => {
    const { deps } = fakeX([term, { id: 5, title: 'helper', x: 0, y: 0, width: 1, height: 1 }])
    expect((await listX11Windows(deps)).map((w) => w.id)).toEqual([term.id])
  })
})

describe('lookupX11Window', () => {
  it('shown: its facts now, wherever it moved', async () => {
    const { deps } = fakeX([{ ...term, x: 300, y: 200 }])
    expect(await lookupX11Window(term.id, deps)).toMatchObject({ state: 'shown', window: { x: 300, y: 200, width: 484 } })
  })

  it('alive but not shown (minimised, unmapped): hidden, which recovers by itself', async () => {
    const { deps } = fakeX([{ ...term, hidden: true }, eyes])
    expect(await lookupX11Window(term.id, deps)).toEqual({ state: 'hidden' })
  })

  it('X no longer knows it: gone', async () => {
    expect(await lookupX11Window(term.id, fakeX([eyes]).deps)).toEqual({ state: 'gone' })
  })

  it('a failure that proves nothing is thrown, not called gone', async () => {
    const { deps, xdotool } = fakeX([term])
    xdotool.mockRejectedValue(new Error("Error: Can't open display: :99"))
    await expect(lookupX11Window(term.id, deps)).rejects.toThrow(/open display/)
  })
})

describe('findX11Window', () => {
  const list: X11Window[] = [
    { id: 1, title: 'notes.txt - gedit', app: 'Gedit', pid: 1, x: 0, y: 0, width: 100, height: 100 },
    { id: 2, title: 'term one', app: 'XTerm', pid: 2, x: 0, y: 0, width: 100, height: 100 }
  ]
  it('exact app first, then an app that contains it; the title must contain the detail', () => {
    expect(findX11Window(list, 'xterm', null)?.id).toBe(2)
    expect(findX11Window(list, 'edit', null)?.id).toBe(1)
    expect(findX11Window(list, 'gedit', 'notes')?.id).toBe(1)
    expect(findX11Window(list, 'gedit', 'other')).toBeNull()
  })
})

describe('windowFocusCalls', () => {
  it('asks the window manager to activate it (a failure is fine with none), then raises and focuses it in X itself', () => {
    const calls = windowFocusCalls(4194316)
    expect(calls.optional.argv).toEqual(['windowactivate', '4194316'])
    expect(calls.required.argv).toEqual(['windowraise', '4194316', 'windowfocus', '4194316', 'sleep', '0.05'])
  })
})
