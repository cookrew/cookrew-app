// THE MAC'S INPUT HAND (main/mac-bridge.ts), DRY: the real osascript helper
// builds every event and posts none, so this never moves the owner's mouse.
// It proves the JSON-line protocol, the closed vocabulary, and that one bad
// line is refused without knocking the next one out of step.
import { describe, expect, it } from 'vitest'
import { MacInput, macKeyCode } from '../src/main/mac-bridge'

describe.skipIf(process.platform !== 'darwin')('MacInput (dry)', () => {
  it('answers each operation in order, and refuses a malformed one without losing step', async () => {
    const hand = new MacInput({ dry: true })
    try {
      await hand.send({ op: 'ping' })
      await hand.send({ op: 'click', x: 10, y: 10 })
      await hand.send({ op: 'drag', x1: 10, y1: 10, x2: 40, y2: 40, ms: 60 })
      await hand.send({ op: 'scroll', x: 10, y: 10, dx: 0, dy: 120 })
      await hand.send({ op: 'key', code: 36 })
      await hand.send({ op: 'type', text: 'hé 你好' })
      await expect(hand.send({ op: 'click', x: Number.NaN, y: 1 })).rejects.toThrow(/refused/)
      await expect(hand.send({ op: 'shell', cmd: 'ls' } as never)).rejects.toThrow(/refused/)
      await hand.send({ op: 'ping' })
    } finally {
      hand.close()
    }
  }, 20_000)
})

describe('macKeyCode', () => {
  it('knows the vocabulary keys and nothing else', () => {
    expect(macKeyCode('return')).toBe(36)
    expect(macKeyCode('escape')).toBe(53)
    expect(macKeyCode('command')).toBeNull()
  })
})
