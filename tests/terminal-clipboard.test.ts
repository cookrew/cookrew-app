import { describe, expect, it, vi } from 'vitest'
import {
  PRESS_HOLD_MS,
  PRESS_SLOP_PX,
  pasteFromClipboard,
  pastePress,
  type PastePressState
} from '../src/renderer/src/terminal-clipboard'

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

const IDLE: PastePressState = { kind: 'idle' }
const holding = (armed = false): PastePressState => ({ kind: 'holding', x: 100, y: 200, armed })
const down = (touches = 1): Parameters<typeof pastePress>[1] => ({ type: 'down', x: 100, y: 200, touches })

describe('pastePress — a hold on the live pane, judged on release', () => {
  it('pastes when a still finger matures and lifts', () => {
    const pressed = pastePress(IDLE, down())
    expect(pressed.state).toEqual(holding(false))
    expect(pressed.paste).toBe(false)

    const matured = pastePress(pressed.state, { type: 'hold' })
    expect(matured.arm).toBe(true)
    expect(matured.state).toEqual(holding(true))

    const released = pastePress(matured.state, { type: 'up' })
    expect(released.paste).toBe(true)
    expect(released.disarm).toBe(true)
    expect(released.state).toEqual(IDLE)
  })

  it('pastes nothing when the finger travels past the slop — that was a scroll', () => {
    const moved = pastePress(holding(true), { type: 'move', x: 100, y: 200 + PRESS_SLOP_PX + 1 })
    expect(moved.state).toEqual({ kind: 'refused' })
    expect(moved.disarm).toBe(true)
    expect(pastePress(moved.state, { type: 'up' }).paste).toBe(false)
  })

  it('tolerates the slop itself, so a resting thumb still pastes', () => {
    const wobbled = pastePress(holding(true), { type: 'move', x: 100 + PRESS_SLOP_PX, y: 200 })
    expect(wobbled.state).toEqual(holding(true))
    expect(pastePress(wobbled.state, { type: 'up' }).paste).toBe(true)
  })

  it('pastes nothing on a release before the hold matures — that tap belongs to xterm', () => {
    const released = pastePress(holding(false), { type: 'up' })
    expect(released.paste).toBe(false)
    expect(released.disarm).toBe(false)
  })

  it('refuses a second finger, and refuses one that joins a matured hold', () => {
    expect(pastePress(IDLE, down(2)).state).toEqual({ kind: 'refused' })
    const joined = pastePress(holding(true), down(2))
    expect(joined.state).toEqual({ kind: 'refused' })
    expect(joined.disarm).toBe(true)
    expect(pastePress(joined.state, { type: 'up' }).paste).toBe(false)
  })

  it('cannot mature twice, so one hold is one paste', () => {
    const again = pastePress(holding(true), { type: 'hold' })
    expect(again.arm).toBe(false)
    expect(again.state).toEqual(holding(true))
  })

  it('cannot mature after it was refused', () => {
    const matured = pastePress({ kind: 'refused' }, { type: 'hold' })
    expect(matured.arm).toBe(false)
    expect(matured.state).toEqual({ kind: 'refused' })
  })

  it('takes the outline back off when the touch is cancelled', () => {
    const cancelled = pastePress(holding(true), { type: 'cancel' })
    expect(cancelled.disarm).toBe(true)
    expect(cancelled.paste).toBe(false)
    expect(cancelled.state).toEqual(IDLE)
  })

  it('starts fresh after a refusal, so the next press can paste', () => {
    const fresh = pastePress({ kind: 'refused' }, down())
    expect(fresh.state).toEqual(holding(false))
    expect(pastePress(pastePress(fresh.state, { type: 'hold' }).state, { type: 'up' }).paste).toBe(true)
  })

  it('holds for the same beat as the canvas long-press', () => {
    expect(PRESS_HOLD_MS).toBe(550)
  })
})
