// WHO TYPED IT. `cookrew ask "Shell" --raw` gives an agent a real terminal: a
// Shell card has a tty, no claude ancestor and no turn, so every check on the
// CALLER passes. The keys are what differ. Anything that is not a keyboard marks
// the pane as driven, a keyboard clears the mark, login refuses a driven pane, and
// nothing but a keyboard reaches a sealed one.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneInputs, paneInputs, SEALED_REFUSAL } from '../src/main/pane-input'
import { askRaw, askTerminal, ownerSubmit } from '../src/main/ask'
import type { PtySession } from '../src/main/pty'

const fakeSession = (terminalId: string): { session: PtySession; written: string[] } => {
  const written: string[] = []
  const session = {
    terminalId,
    hostBacked: false,
    write: (data: string) => {
      written.push(data)
      return 'allow'
    },
    writeFromOwner: (data: string) => {
      written.push(data)
      return true
    },
    viewportText: () => ''
  } as unknown as PtySession
  return { session, written }
}

describe('PaneInputs', () => {
  let inputs: PaneInputs
  beforeEach(() => {
    inputs = new PaneInputs()
  })

  it('holds a seal by terminal id, so a session made later is sealed too', () => {
    const release = inputs.seal('t')
    expect(inputs.sealed('t')).toBe(true)
    expect(inputs.sealed('other')).toBe(false)
    release()
    expect(inputs.sealed('t')).toBe(false)
  })

  it('counts holders, and a second release changes nothing', () => {
    const first = inputs.seal('t')
    const second = inputs.seal('t')
    first()
    first()
    expect(inputs.sealed('t')).toBe(true)
    second()
    expect(inputs.sealed('t')).toBe(false)
  })

  it('is driven from the first write that is not a keyboard, until a key is pressed', () => {
    expect(inputs.driven('t')).toBe(false)
    expect(inputs.drive('t')).toBe(true)
    expect(inputs.driven('t')).toBe(true)
    inputs.noteKeyboard('t')
    expect(inputs.driven('t')).toBe(false)
  })

  it('does not forget with time: `sleep 31; cookrew logout` gains nothing', () => {
    vi.useFakeTimers()
    inputs.drive('t')
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(inputs.driven('t')).toBe(true)
    vi.useRealTimers()
  })

  it('refuses to drive a sealed pane, and says so to the caller', () => {
    inputs.seal('t')
    expect(inputs.drive('t')).toBe(false)
  })
})

describe('`cookrew ui type`, which is not a keyboard and looks like one', () => {
  it('counts the keys it injects as driven, for good', () => {
    let at = 1_000
    const inputs = new PaneInputs(() => at)
    expect(inputs.driveWindow()).toBe(true)
    at += 500
    inputs.noteWindowKey('t')
    expect(inputs.driven('t')).toBe(true)
    at += 60_000
    expect(inputs.driven('t')).toBe(true)
  })

  it('leaves a real key a real key, once the injection has passed', () => {
    let at = 1_000
    const inputs = new PaneInputs(() => at)
    inputs.drive('t')
    inputs.driveWindow()
    at += 5_000
    inputs.noteWindowKey('t')
    expect(inputs.driven('t')).toBe(false)
  })

  it('is a real key when nothing was ever injected', () => {
    const inputs = new PaneInputs(() => 0)
    inputs.drive('t')
    inputs.noteWindowKey('t')
    expect(inputs.driven('t')).toBe(false)
  })

  it('is refused while any pane is at a hidden prompt: it cannot say which pane it reaches', () => {
    const inputs = new PaneInputs()
    const release = inputs.seal('t')
    expect(inputs.driveWindow()).toBe(false)
    release()
    expect(inputs.driveWindow()).toBe(true)
  })
})

describe('the producers', () => {
  it('ownerSubmit defaults to not a keyboard: refused on a sealed pane, nothing written', async () => {
    const { session, written } = fakeSession('drive-1')
    const release = paneInputs.seal('drive-1')
    expect(await ownerSubmit(session, 'hunter2\r')).toEqual({ ok: false, reason: SEALED_REFUSAL })
    expect(written).toEqual([])
    release()
  })

  it('ownerSubmit marks the pane it reaches', async () => {
    const { session } = fakeSession('drive-2')
    await ownerSubmit(session, 'x')
    expect(paneInputs.driven('drive-2')).toBe(true)
  })

  it('the phone keyboard is a keyboard: it reaches a sealed pane, and clears the mark', async () => {
    const { session, written } = fakeSession('drive-3')
    paneInputs.drive('drive-3')
    const release = paneInputs.seal('drive-3')
    expect(await ownerSubmit(session, 'x', { keyboard: true })).toMatchObject({ ok: true })
    expect(written).toEqual(['x'])
    expect(paneInputs.driven('drive-3')).toBe(false)
    release()
  })

  it('`cookrew ask --raw` cannot type at a hidden prompt', async () => {
    const { session, written } = fakeSession('drive-4')
    const release = paneInputs.seal('drive-4')
    await expect(askRaw(session, 'hunter2\r')).rejects.toThrow(SEALED_REFUSAL)
    expect(written).toEqual([])
    release()
  })

  it('`cookrew ask` cannot either, before it reaches any backend', async () => {
    const { session, written } = fakeSession('drive-5')
    const release = paneInputs.seal('drive-5')
    await expect(askTerminal(session, 'hunter2')).rejects.toThrow(SEALED_REFUSAL)
    expect(written).toEqual([])
    release()
  })
})
