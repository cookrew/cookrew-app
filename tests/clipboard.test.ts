import { describe, expect, it, vi } from 'vitest'
import { readClipboardText, writeClipboardText } from '../src/renderer/src/clipboard'
import type { ClipboardEnv } from '../src/renderer/src/clipboard'

function env(overrides: Partial<ClipboardEnv>): ClipboardEnv {
  return { clipboard: undefined, execCopy: () => false, ...overrides }
}

describe('writeClipboardText', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn(async () => undefined)
    const execCopy = vi.fn(() => true)
    const ok = await writeClipboardText('hello', env({ clipboard: { writeText }, execCopy }))
    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCopy).not.toHaveBeenCalled()
  })

  it('falls back to execCommand copy when clipboard API is missing (insecure context)', async () => {
    const execCopy = vi.fn(() => true)
    const ok = await writeClipboardText('tmux selection', env({ execCopy }))
    expect(ok).toBe(true)
    expect(execCopy).toHaveBeenCalledWith('tmux selection')
  })

  it('falls back when the clipboard API rejects', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    const execCopy = vi.fn(() => true)
    const ok = await writeClipboardText('x', env({ clipboard: { writeText }, execCopy }))
    expect(ok).toBe(true)
    expect(execCopy).toHaveBeenCalled()
  })

  it('reports failure when no path works', async () => {
    const ok = await writeClipboardText('x', env({ execCopy: () => false }))
    expect(ok).toBe(false)
  })
})

describe('readClipboardText', () => {
  it('returns null when the context has no readable clipboard', async () => {
    expect(await readClipboardText(env({}))).toBe(null)
    expect(
      await readClipboardText(env({ clipboard: { writeText: async () => undefined } }))
    ).toBe(null)
  })

  it('returns clipboard text when available', async () => {
    const clipboard = { writeText: async () => undefined, readText: async () => 'pasted' }
    expect(await readClipboardText(env({ clipboard }))).toBe('pasted')
  })

  it('returns null when reading rejects', async () => {
    const clipboard = {
      writeText: async () => undefined,
      readText: async (): Promise<string> => {
        throw new Error('denied')
      }
    }
    expect(await readClipboardText(env({ clipboard }))).toBe(null)
  })
})
