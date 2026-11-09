// THIS LINUX MACHINE'S HAND (main/linux-input.ts): the gesture vocabulary as
// xdotool argv, the display mapping, and the hand's own gates. Nothing runs:
// the runner is a fake, and the dry run is checked to start nothing either.
import { describe, expect, it, vi } from 'vitest'
import { LINUX_NO_XDOTOOL, XDOTOOL_INSTALL } from '../src/shared/remote-access'
import {
  createLinuxHand,
  findXdotool,
  linuxInputDryRun,
  MAX_TYPE_CHARS,
  NO_WHEEL,
  SCROLL_STEP_PX,
  xdotoolCalls,
  xdotoolKey,
  type DisplayArea,
  type LinuxHandDeps
} from '../src/main/linux-input'
import type { Gesture } from '../src/main/vphone-input'

const frame = { width: 1000, height: 500 }
const area: DisplayArea = { x: 0, y: 0, width: 2000, height: 1000 }
const right: DisplayArea = { x: 1920, y: 0, width: 1280, height: 1024 }
const argv = (gesture: Gesture, on: DisplayArea = area) => xdotoolCalls(gesture, frame, on, NO_WHEEL).calls.map((call) => call.argv)

describe('xdotoolCalls: pointer', () => {
  it('a tap is a move and a left click, the frame point mapped by its ratio onto the display', () => {
    expect(argv({ method: 'input.tap', params: { x: 500, y: 250 } })).toEqual([['mousemove', '1000', '500', 'click', '1']])
    expect(argv({ method: 'input.tap', params: { x: 0, y: 0 } })).toEqual([['mousemove', '0', '0', 'click', '1']])
  })

  it('a display that is not the first is reached at its own place on the X screen', () => {
    expect(argv({ method: 'input.tap', params: { x: 500, y: 250 } }, right)).toEqual([['mousemove', '2560', '512', 'click', '1']])
  })

  it('a point off the frame is held at its edge: nothing lands on another display', () => {
    expect(argv({ method: 'input.tap', params: { x: 5000, y: -40 } }, right)).toEqual([['mousemove', String(1920 + 1279), '0', 'click', '1']])
    expect(argv({ method: 'input.tap', params: { x: 'NaN', y: Number.POSITIVE_INFINITY } })).toEqual([['mousemove', '0', '0', 'click', '1']])
  })

  it('a swipe is one drag: press, moves spread over its time, release', () => {
    const [call] = argv({ method: 'input.swipe', params: { x1: 0, y1: 0, x2: 1000, y2: 500, seconds: 0.4 } })
    expect(call.slice(0, 5)).toEqual(['mousemove', '0', '0', 'mousedown', '1'])
    expect(call.slice(-2)).toEqual(['mouseup', '1'])
    const moves = call.flatMap((word, i) => (word === 'mousemove' ? [[call[i + 1], call[i + 2]]] : []))
    expect(moves.at(-1)).toEqual(['1999', '999'])
    expect(moves.length).toBeGreaterThan(4)
    const sleeps = call.flatMap((word, i) => (word === 'sleep' ? [Number(call[i + 1])] : []))
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(0.4 + 0.05, 2)
  })

  it('a swipe with no time still moves in steps, and one with a huge time is held', () => {
    const quick = argv({ method: 'input.swipe', params: { x1: 0, y1: 0, x2: 10, y2: 10, seconds: 0 } })[0]
    const slow = argv({ method: 'input.swipe', params: { x1: 0, y1: 0, x2: 10, y2: 10, seconds: 999 } })[0]
    const total = (call: readonly string[]) => call.flatMap((word, i) => (word === 'sleep' ? [Number(call[i + 1])] : [])).reduce((a, b) => a + b, 0)
    expect(total(quick)).toBeGreaterThan(0)
    expect(total(slow)).toBeLessThanOrEqual(2.1)
  })
})

describe('xdotoolCalls: scroll', () => {
  it('down and right are buttons 5 and 7, up and left 4 and 6, at the pointer', () => {
    expect(argv({ method: 'input.scroll', params: { x: 500, y: 250, dx: 0, dy: SCROLL_STEP_PX * 3 } })).toEqual([['mousemove', '1000', '500', 'click', '--repeat', '3', '--delay', '15', '5']])
    expect(argv({ method: 'input.scroll', params: { x: 500, y: 250, dx: -SCROLL_STEP_PX, dy: -SCROLL_STEP_PX } })).toEqual([
      ['mousemove', '1000', '500', 'click', '--repeat', '1', '--delay', '15', '4'],
      ['mousemove', '1000', '500', 'click', '--repeat', '1', '--delay', '15', '6']
    ])
    expect(argv({ method: 'input.scroll', params: { x: 1, y: 1, dx: SCROLL_STEP_PX * 2, dy: 0 } })[0].at(-1)).toBe('7')
  })

  it('a trackpad sends small deltas: they add up across scrolls instead of each being a whole click', () => {
    const small: Gesture = { method: 'input.scroll', params: { x: 1, y: 1, dx: 0, dy: SCROLL_STEP_PX / 4 } }
    let wheel = NO_WHEEL
    const clicks: number[] = []
    for (let i = 0; i < 8; i += 1) {
      const next = xdotoolCalls(small, frame, area, wheel)
      wheel = next.wheel
      clicks.push(next.calls.length)
    }
    expect(clicks.reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('a flood of wheel is capped per scroll', () => {
    const [call] = argv({ method: 'input.scroll', params: { x: 1, y: 1, dx: 0, dy: SCROLL_STEP_PX * 1000 } })
    expect(Number(call[call.indexOf('--repeat') + 1])).toBeLessThanOrEqual(20)
  })
})

describe('xdotoolCalls: keys and text', () => {
  it('named keys are X keysyms', () => {
    expect(argv({ method: 'input.key', params: { name: 'return' } })).toEqual([['key', '--clearmodifiers', 'Return']])
    expect(argv({ method: 'input.key', params: { name: 'delete' } })).toEqual([['key', '--clearmodifiers', 'BackSpace']])
    for (const [name, sym] of [['tab', 'Tab'], ['escape', 'Escape'], ['space', 'space'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right']]) {
      expect(xdotoolKey(name)).toBe(sym)
    }
  })

  it('a shortcut (cmd from the viewer) is Ctrl on Linux', () => {
    expect(argv({ method: 'input.key', params: { name: 'c', mods: 'cmd' } })).toEqual([['key', '--clearmodifiers', 'ctrl+c']])
    expect(argv({ method: 'input.key', params: { name: '1', mods: 'cmd' } })).toEqual([['key', '--clearmodifiers', 'ctrl+1']])
  })

  it('a key with no X name is refused in words, never passed through for xdotool to read', () => {
    expect(() => argv({ method: 'input.key', params: { name: 'ctrl+alt+Delete' } })).toThrow(/no 'ctrl\+alt\+Delete' key on this machine/)
    expect(() => argv({ method: 'input.key', params: { name: '--help' } })).toThrow(/no '--help' key/)
  })

  it('text is one argument after --, so nothing in it is an option, a command or a shell word', () => {
    const tricky = '--window 1 key ctrl+alt+Delete $(rm -rf ~) `id` ; "quoted" \\n'
    expect(argv({ method: 'input.type', params: { text: tricky } })).toEqual([['type', '--clearmodifiers', '--delay', '12', '--', tricky]])
    expect(argv({ method: 'input.paste', params: { text: 'héllo 你好' } })).toEqual([['type', '--clearmodifiers', '--delay', '12', '--', 'héllo 你好']])
  })

  it('long text goes in pieces, never split inside a character, and empty text is nothing', () => {
    const text = '😀'.repeat(700)
    const calls = argv({ method: 'input.type', params: { text } })
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.map((call) => call.at(-1)).join('')).toBe(text)
    expect(argv({ method: 'input.type', params: { text: '' } })).toEqual([])
  })

  it('more than a person would paste is refused in words', () => {
    expect(() => argv({ method: 'input.paste', params: { text: 'x'.repeat(MAX_TYPE_CHARS + 1) } })).toThrow(/too long to type/)
  })

  it('every call carries a timeout that outlasts what it does', () => {
    const { calls } = xdotoolCalls({ method: 'input.type', params: { text: 'x'.repeat(400) } }, frame, area, NO_WHEEL)
    expect(calls[0].timeoutMs).toBeGreaterThan(400 * 12)
    const drag = xdotoolCalls({ method: 'input.swipe', params: { x1: 0, y1: 0, x2: 1, y2: 1, seconds: 2 } }, frame, area, NO_WHEEL)
    expect(drag.calls[0].timeoutMs).toBeGreaterThan(2000)
  })
})

describe('findXdotool', () => {
  it('looks along PATH, then the usual places', () => {
    const exists = (file: string) => file === '/usr/bin/xdotool'
    expect(findXdotool({ PATH: '/opt/x:/usr/local/bin' }, exists)).toBe('/usr/bin/xdotool')
    expect(findXdotool({ PATH: '/opt/x' }, (file) => file === '/opt/x/xdotool')).toBe('/opt/x/xdotool')
    expect(findXdotool({ PATH: '' }, () => false)).toBeNull()
  })

  it('a relative PATH entry is not a place to run a tool from', () => {
    expect(findXdotool({ PATH: '.:bin' }, (file) => !file.startsWith('/'))).toBeNull()
  })
})

describe('linuxInputDryRun', () => {
  it('is on only for 1', () => {
    expect(linuxInputDryRun({ COOKREW_LINUX_INPUT_DRY_RUN: '1' })).toBe(true)
    expect(linuxInputDryRun({ COOKREW_LINUX_INPUT_DRY_RUN: 'true' })).toBe(false)
    expect(linuxInputDryRun({})).toBe(false)
  })
})

describe('createLinuxHand', () => {
  const hand = (over: Partial<LinuxHandDeps> = {}) => {
    const run = vi.fn(async () => undefined)
    const log = vi.fn()
    const deps: LinuxHandDeps = { screenRefusal: () => null, find: () => '/usr/bin/xdotool', run, dryRun: false, log, ...over }
    return { hand: createLinuxHand(deps), run, log }
  }
  const tap = { argv: ['mousemove', '1', '2', 'click', '1'], timeoutMs: 5000 }

  it('runs each call as an argv array on the binary it found', async () => {
    const { hand: h, run } = hand()
    await h.send([tap])
    expect(run).toHaveBeenCalledWith('/usr/bin/xdotool', tap.argv, 5000)
  })

  it('with no xdotool it refuses in one sentence naming the fix, and runs nothing', async () => {
    const { hand: h, run } = hand({ find: () => null })
    expect(h.refusal()).toBe(LINUX_NO_XDOTOOL)
    expect(LINUX_NO_XDOTOOL).toContain(XDOTOOL_INSTALL)
    await expect(h.send([tap])).rejects.toThrow(LINUX_NO_XDOTOOL)
    expect(run).not.toHaveBeenCalled()
  })

  it('Wayland and a missing display are refused by name, ahead of xdotool', async () => {
    const { hand: h, run } = hand({ screenRefusal: () => 'This Linux session runs Wayland', find: () => null })
    expect(h.refusal()).toBe('This Linux session runs Wayland')
    await expect(h.send([tap])).rejects.toThrow(/Wayland/)
    expect(run).not.toHaveBeenCalled()
  })

  it('a dry run logs the argv, needs no xdotool, and starts nothing', async () => {
    const { hand: h, run, log } = hand({ dryRun: true, find: () => null })
    expect(h.refusal()).toBeNull()
    await h.send([tap])
    expect(run).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('["mousemove","1","2","click","1"]'))
  })

  it('a dry run never writes what was typed, only how long it was', async () => {
    const { hand: h, log } = hand({ dryRun: true })
    await h.send([{ argv: ['type', '--clearmodifiers', '--delay', '12', '--', 'hunter2'], timeoutMs: 5000 }])
    const line = String(log.mock.calls[0]?.[0])
    expect(line).not.toContain('hunter2')
    expect(line).toContain('<7 characters>')
  })

  it('a dry run still refuses Wayland: it is a run of the real gates', () => {
    const { hand: h } = hand({ dryRun: true, screenRefusal: () => 'Wayland' })
    expect(h.refusal()).toBe('Wayland')
  })

  it('a drag that fails lets go of the button, so the mouse is never left down', async () => {
    const run = vi.fn(async (_bin: string, args: readonly string[]) => {
      if (args.includes('mousedown')) throw new Error('xdotool did not answer')
    })
    const { hand: h } = hand({ run })
    await expect(h.send([{ argv: ['mousemove', '0', '0', 'mousedown', '1', 'mousemove', '9', '9', 'mouseup', '1'], timeoutMs: 100 }])).rejects.toThrow(/did not answer/)
    expect(run).toHaveBeenLastCalledWith('/usr/bin/xdotool', ['mouseup', '1'], expect.any(Number))
  })

  it('stops at the first call that fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('xdotool: Can not open display')
    })
    const { hand: h } = hand({ run })
    await expect(h.send([tap, tap])).rejects.toThrow(/open display/)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('createLinuxHand: cut short, and one at a time', () => {
  const pieces = (n: number) => Array.from({ length: n }, (_, i) => ({ argv: ['type', '--', `p${i}`], timeoutMs: 1000 }))

  it('Stop between two pieces of a paste stops the rest', async () => {
    const run = vi.fn(async () => undefined)
    const h = createLinuxHand({ screenRefusal: () => null, find: () => '/usr/bin/xdotool', run, dryRun: false, log: vi.fn() })
    let calls = 0
    await expect(h.send(pieces(5), () => (++calls > 2 ? 'Stopped at the machine' : null))).rejects.toThrow('Stopped at the machine')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('two cards never interleave: the second gesture waits for the first', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const run = vi.fn(async (_bin: string, argv: readonly string[]) => {
      order.push(`start ${argv[0]}`)
      if (argv[0] === 'mousemove') await new Promise<void>((resolve) => (release = resolve))
      order.push(`end ${argv[0]}`)
    })
    const h = createLinuxHand({ screenRefusal: () => null, find: () => '/usr/bin/xdotool', run, dryRun: false, log: vi.fn() })
    const first = h.send([{ argv: ['mousemove', '0', '0', 'mousedown', '1'], timeoutMs: 1000 }])
    const second = h.send([{ argv: ['key', 'Return'], timeoutMs: 1000 }])
    await new Promise((resolve) => setTimeout(resolve, 5))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start mousemove', 'end mousemove', 'start key', 'end key'])
  })

  it('a failed gesture does not jam the ones after it', async () => {
    const run = vi.fn(async (_bin: string, argv: readonly string[]) => {
      if (argv[0] === 'bad') throw new Error('xdotool: no')
    })
    const h = createLinuxHand({ screenRefusal: () => null, find: () => '/usr/bin/xdotool', run, dryRun: false, log: vi.fn() })
    await expect(h.send([{ argv: ['bad'], timeoutMs: 1 }])).rejects.toThrow('no')
    await expect(h.send([{ argv: ['key', 'Return'], timeoutMs: 1 }])).resolves.toBeUndefined()
  })

  it('a key name that is an object property is still no key', () => {
    expect(xdotoolKey('constructor')).toBeNull()
    expect(xdotoolKey('toString')).toBeNull()
  })
})

describe('createLinuxHand: optional calls', () => {
  it('an optional call that fails (no window manager to activate with) does not stop the gesture', async () => {
    const run = vi.fn(async (_bin: string, argv: readonly string[]) => {
      if (argv[0] === 'windowactivate') throw new Error('xdotool: Your windowmanager claims not to support _NET_ACTIVE_WINDOW')
    })
    const h = createLinuxHand({ screenRefusal: () => null, find: () => '/usr/bin/xdotool', run, dryRun: false, log: vi.fn() })
    await h.send([{ argv: ['windowactivate', '7'], timeoutMs: 1, optional: true }, { argv: ['key', 'Return'], timeoutMs: 1 }])
    expect(run).toHaveBeenCalledTimes(2)
  })
})
