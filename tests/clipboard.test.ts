import { afterEach, describe, expect, it, vi } from 'vitest'
import { readClipboardText, writeClipboardLater, writeClipboardText } from '../src/renderer/src/clipboard'
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

describe('writeClipboardLater — a copy that comes back after the tap', () => {
  afterEach(() => vi.unstubAllGlobals())

  class FakeItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }

  it('starts the write IN the tap with a promised item, and finishes when the text comes', async () => {
    const written: FakeItem[] = []
    let started = false
    vi.stubGlobal('ClipboardItem', FakeItem)
    vi.stubGlobal('navigator', {
      clipboard: {
        write: vi.fn(async (items: FakeItem[]) => {
          started = true
          written.push(...items)
          await items[0].items['text/plain']
        }),
        writeText: vi.fn()
      }
    })
    let arrive: (text: string | null) => void = () => undefined
    const pending = writeClipboardLater(new Promise((resolve) => (arrive = resolve)))
    // Synchronously, before any text: the write has already begun.
    expect(started).toBe(true)
    arrive('copied words')
    expect(await pending).toEqual({ text: 'copied words', ok: true })
    expect(await (await written[0].items['text/plain']).text()).toBe('copied words')
  })

  it('nothing copied: no write, not ok', async () => {
    vi.stubGlobal('ClipboardItem', FakeItem)
    const writeText = vi.fn()
    vi.stubGlobal('navigator', {
      clipboard: {
        write: vi.fn(async (items: FakeItem[]) => {
          await items[0].items['text/plain']
        }),
        writeText
      }
    })
    expect(await writeClipboardLater(Promise.resolve(null))).toEqual({ text: null, ok: false })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('without promised items it writes the plain way once the text is in', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('ClipboardItem', undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await writeClipboardLater(Promise.resolve('plain'))).toEqual({ text: 'plain', ok: true })
    expect(writeText).toHaveBeenCalledWith('plain')
  })
})
