import { describe, expect, it, vi } from 'vitest'
import { pasteFromClipboard } from '../src/renderer/src/terminal-clipboard'

describe('pasteFromClipboard — three answers, one paste at most', () => {
  it('pastes text exactly once', async () => {
    const paste = vi.fn()
    expect(await pasteFromClipboard(async () => 'hello', paste)).toBe('pasted')
    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith('hello')
  })

  it('reports an empty clipboard without pasting', async () => {
    const paste = vi.fn()
    expect(await pasteFromClipboard(async () => '', paste)).toBe('empty')
    expect(paste).not.toHaveBeenCalled()
  })

  it('reports an unreadable clipboard (insecure context, dismissed prompt) without pasting', async () => {
    const paste = vi.fn()
    expect(await pasteFromClipboard(async () => null, paste)).toBe('unavailable')
    expect(paste).not.toHaveBeenCalled()
  })

  it('reads BEFORE it awaits anything, so the caller keeps its user activation', async () => {
    // iOS refuses a clipboard read outside a gesture; if this ever grows an
    // await before read(), the phone's paste silently stops working.
    let readDuringCall = false
    const promise = pasteFromClipboard(
      () => {
        readDuringCall = true
        return Promise.resolve('x')
      },
      () => undefined
    )
    expect(readDuringCall).toBe(true)
    await promise
  })
})
