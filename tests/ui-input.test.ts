// `cookrew ui` puts real input events in the window, where a focused pane reads
// them as keys. So every event asks first, not just the command: a `ui type`
// running when a hidden prompt opens has to stop at that character.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { paneInputs, SEALED_REFUSAL } from '../src/main/pane-input'
import { injectWindowInput } from '../src/main/ui-input'

const fakeWindow = (onEvent: (sent: number) => void = () => undefined) => {
  const events: unknown[] = []
  return {
    events,
    wc: {
      sendInputEvent: (event: unknown) => {
        events.push(event)
        onEvent(events.length)
      }
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('injectWindowInput', () => {
  it('sends what it always sent', async () => {
    const { events, wc } = fakeWindow()
    expect(await injectWindowInput(wc, ['click', '3', '4'])).toBe('Clicked 3,4')
    expect(events).toHaveLength(2)
    expect(await injectWindowInput(wc, ['key', 'Enter', 'meta+shift'])).toBe('Pressed Enter +meta+shift')
    expect(await injectWindowInput(wc, ['type', 'ab'])).toBe('Typed 2 chars')
    expect(events).toHaveLength(6)
    await expect(injectWindowInput(wc, ['nonsense'])).rejects.toThrow('Usage: cookrew ui')
  })

  it.each([
    [['click', '1', '2']],
    [['dblclick', '1', '2']],
    [['type', 'hunter2']],
    [['key', 'Enter']]
  ])('sends nothing while a pane is sealed: %j', async (args) => {
    const { events, wc } = fakeWindow()
    const release = paneInputs.seal('ui-1')
    await expect(injectWindowInput(wc, args)).rejects.toThrow(SEALED_REFUSAL)
    release()
    expect(events).toEqual([])
  })

  it('stops a `ui type` already running at the character the seal opens on', async () => {
    let release: () => void = () => undefined
    const { events, wc } = fakeWindow((sent) => {
      if (sent === 2) release = paneInputs.seal('ui-2')
    })
    await expect(injectWindowInput(wc, ['type', 'padding then hunter2\r'])).rejects.toThrow(SEALED_REFUSAL)
    release()
    expect(events).toHaveLength(2)
  })

  it('keeps every key of a long `ui type` driven: the mark does not lapse halfway', async () => {
    let at = 0
    vi.spyOn(Date, 'now').mockImplementation(() => at)
    const { wc } = fakeWindow(() => {
      at += 1_000
      paneInputs.noteWindowKey('ui-3')
    })
    paneInputs.noteDriven('ui-3')
    await injectWindowInput(wc, ['type', 'x'.repeat(6)])
    vi.restoreAllMocks()
    expect(paneInputs.driven('ui-3')).toBe(true)
  })
})
