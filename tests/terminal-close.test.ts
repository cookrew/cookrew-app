import { describe, expect, it, vi } from 'vitest'
import { TerminalCloser } from '../src/main/terminal-close'

describe('TerminalCloser', () => {
  it('a close that ended the terminal reports ok, and nothing else', async () => {
    const survived = vi.fn()
    const closer = new TerminalCloser({ kill: async () => undefined, survived })
    await expect(closer.close('a')).resolves.toEqual({ ok: true })
    expect(survived).not.toHaveBeenCalled()
  })

  it('a survivor is named, with why, and the caller is told', async () => {
    const survived = vi.fn()
    const closer = new TerminalCloser({
      kill: async () => {
        throw new Error('process 42 is still running')
      },
      survived
    })
    await expect(closer.close('a')).resolves.toEqual({ ok: false, error: 'process 42 is still running' })
    expect(survived).toHaveBeenCalledWith('a', 'process 42 is still running')
  })

  it('two closes of one card are one close: a double tap must not race its own kill', async () => {
    let finish: () => void = () => undefined
    const kill = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const closer = new TerminalCloser({ kill, survived: vi.fn() })
    const first = closer.close('a')
    const second = closer.close('a')
    finish()
    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).resolves.toEqual({ ok: true })
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('a later close tries again: the first one is over', async () => {
    const kill = vi.fn(async () => undefined)
    const closer = new TerminalCloser({ kill, survived: vi.fn() })
    await closer.close('a')
    await closer.close('a')
    expect(kill).toHaveBeenCalledTimes(2)
  })

  it('closeAll ends every terminal and returns only the survivors', async () => {
    const closer = new TerminalCloser({
      kill: async (id) => {
        if (id === 'b') throw new Error('still open')
      },
      survived: vi.fn()
    })
    await expect(closer.closeAll(['a', 'b', 'c'])).resolves.toEqual([{ id: 'b', error: 'still open' }])
  })
})
