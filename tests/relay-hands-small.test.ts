import { describe, expect, it } from 'vitest'
import { parseStreamMessage, remoteReconnectDelayMs, reconnectDelayMs, REMOTE_FIRST_REDIAL_MS } from '../src/renderer/src/browser-stream'
import { socketLine } from '../src/renderer/src/stream-line'
import { typedAfter } from '../src/renderer/src/useRemoteKeyboard'

describe('what a frame says about the page', () => {
  it('reads where the page is scrolled to', () => {
    const message = parseStreamMessage('{"t":"frame","seq":3,"data":"AAAA","meta":{"revision":1,"scrollY":420.5,"pageScaleFactor":0.5}}')
    expect(message).toMatchObject({ kind: 'frame', seq: 3, scrollY: 420.5, pageScaleFactor: 0.5 })
  })

  it('a page at the top is at zero, not unknown', () => {
    expect(parseStreamMessage('{"t":"frame","seq":3,"data":"AAAA","meta":{"scrollY":0}}')).toMatchObject({ scrollY: 0 })
  })

  it('reads a beat', () => {
    expect(parseStreamMessage('{"t":"same","seq":9,"revision":2}')).toEqual({ kind: 'same', seq: 9, revision: 2 })
  })
})

describe('a phone redials at once', () => {
  it('tries first almost immediately, then backs off as before', () => {
    expect(remoteReconnectDelayMs(0)).toBe(REMOTE_FIRST_REDIAL_MS)
    expect(remoteReconnectDelayMs(1)).toBe(reconnectDelayMs(0))
    expect(remoteReconnectDelayMs(3)).toBe(reconnectDelayMs(2))
  })
})

describe('the line carries receipts and says when it is resuming', () => {
  const fake = (): WebSocket & { painted: (seq: number) => void; onresuming: ((on: boolean) => void) | null; seen: number[] } => {
    const seen: number[] = []
    return { readyState: 1, seen, painted: (seq: number) => void seen.push(seq), onresuming: null, send: () => undefined, close: () => undefined } as never
  }

  it('hands a receipt to a socket that takes them, and ignores one that does not', () => {
    const socket = fake()
    socketLine(socket, { onOpen: () => undefined, onMessage: () => undefined, onClose: () => undefined }).receipt(4)
    expect(socket.seen).toEqual([4])
    const plain = { readyState: 1, send: () => undefined, close: () => undefined } as unknown as WebSocket
    expect(() => socketLine(plain, { onOpen: () => undefined, onMessage: () => undefined, onClose: () => undefined }).receipt(4)).not.toThrow()
  })

  it('passes resuming on', () => {
    const socket = fake()
    const said: boolean[] = []
    socketLine(socket, { onOpen: () => undefined, onMessage: () => undefined, onClose: () => undefined, onResuming: (on) => void said.push(on) })
    socket.onresuming?.(true)
    expect(said).toEqual([true])
  })
})

describe('what the bar shows while the page catches up', () => {
  it('follows typing and Backspace, whole characters at a time', () => {
    expect(typedAfter('', 'insertText', 'a')).toBe('a')
    expect(typedAfter('a', 'insertText', '你')).toBe('a你')
    expect(typedAfter('a你', 'deleteContentBackward', null)).toBe('a')
    expect(typedAfter('😀', 'deleteContentBackward', null)).toBe('')
  })

  it('keeps only the tail, and an Enter starts over', () => {
    expect([...typedAfter('x'.repeat(40), 'insertText', 'y')]).toHaveLength(24)
    expect(typedAfter('abc', 'insertLineBreak', null)).toBe('')
  })
})
