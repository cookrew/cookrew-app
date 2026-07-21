import { describe, expect, it, vi } from 'vitest'
import { handleTerminalPaste, type PasteEventLike } from '../src/renderer/src/terminal-paste'

interface FakeFile {
  type: string
}

function textEvent(text: string): PasteEventLike<FakeFile> & {
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
} {
  return {
    clipboardData: { items: [], getData: () => text },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
}

function imageEvent(): PasteEventLike<FakeFile> & {
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
} {
  const file: FakeFile = { type: 'image/png' }
  return {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => ''
    },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
}

describe('handleTerminalPaste (single paste path)', () => {
  it('pastes text exactly once and suppresses the default (no xterm double)', () => {
    const sink = { pasteText: vi.fn(), pasteImages: vi.fn() }
    const event = textEvent('hello world')
    expect(handleTerminalPaste(event, sink)).toBe(true)
    expect(sink.pasteText).toHaveBeenCalledTimes(1)
    expect(sink.pasteText).toHaveBeenCalledWith('hello world')
    expect(sink.pasteImages).not.toHaveBeenCalled()
    // preventDefault + stopPropagation are what stop xterm pasting it again.
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('routes image items to pasteImages and never as text', () => {
    const sink = { pasteText: vi.fn(), pasteImages: vi.fn() }
    const event = imageEvent()
    expect(handleTerminalPaste(event, sink)).toBe(true)
    expect(sink.pasteImages).toHaveBeenCalledOnce()
    expect(sink.pasteText).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('does nothing (and lets the default run) for an empty clipboard', () => {
    const sink = { pasteText: vi.fn(), pasteImages: vi.fn() }
    const event = textEvent('')
    expect(handleTerminalPaste(event, sink)).toBe(false)
    expect(sink.pasteText).not.toHaveBeenCalled()
    expect(sink.pasteImages).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('tolerates a null clipboardData', () => {
    const sink = { pasteText: vi.fn(), pasteImages: vi.fn() }
    const event = {
      clipboardData: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    }
    expect(handleTerminalPaste(event, sink)).toBe(false)
    expect(sink.pasteText).not.toHaveBeenCalled()
  })
})
