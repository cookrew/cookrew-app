import { describe, expect, it, vi } from 'vitest'
import { registerTerminalPaste, requestTerminalPaste } from '../src/renderer/src/terminal-paste-bus'

describe('terminal paste bus — the dock asks, the overlay serves', () => {
  it('calls the registered sink for that terminal, synchronously', () => {
    const sink = vi.fn()
    const off = registerTerminalPaste('t1', sink)
    expect(requestTerminalPaste('t1')).toBe(true)
    expect(sink).toHaveBeenCalledTimes(1)
    off()
  })

  it('reports false for a terminal with no overlay mounted, and calls nothing', () => {
    expect(requestTerminalPaste('nobody-here')).toBe(false)
  })

  it('keeps terminals apart', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = registerTerminalPaste('a', a)
    const offB = registerTerminalPaste('b', b)
    requestTerminalPaste('b')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
  })

  it('unregisters', () => {
    const sink = vi.fn()
    registerTerminalPaste('gone', sink)()
    expect(requestTerminalPaste('gone')).toBe(false)
    expect(sink).not.toHaveBeenCalled()
  })

  it('a stale unregister does NOT unhook the overlay that replaced it', () => {
    // React remounts register the new sink before the old effect's cleanup
    // runs; a blind delete would leave the live overlay unreachable and the
    // paste key dead with no way to tell.
    const old = vi.fn()
    const fresh = vi.fn()
    const offOld = registerTerminalPaste('same', old)
    const offFresh = registerTerminalPaste('same', fresh)
    offOld()
    expect(requestTerminalPaste('same')).toBe(true)
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(old).not.toHaveBeenCalled()
    offFresh()
  })
})
