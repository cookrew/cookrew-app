// THE WINDOW'S HOLD GOES WITH THE PAGE, AND ONLY WITH THE PAGE (R3, round 3).
//
// Round 2 released the inbox hold on `did-start-navigation` / `destroyed` with
// `once` listeners registered on every subscribe and never removed: a hash
// change or an iframe navigation dropped the hold under an open box, and the
// dead closures piled up on the window. This drives the pairing with a fake
// webContents and counts what is bound.

import { describe, expect, it } from 'vitest'
import { createWindowHold, leavesDocument, type HoldableContents } from '../src/main/inbox-window-hold'

type Listener = (...args: unknown[]) => void

/** A webContents that only remembers who is listening. */
const fakeContents = (): HoldableContents & { fire: (event: string, ...args: unknown[]) => void; count: (event: string) => number } => {
  const listeners = new Map<string, Listener[]>()
  return {
    on: (event, listener) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    removeListener: (event, listener) => void listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener)),
    fire: (event, ...args) => (listeners.get(event) ?? []).forEach((l) => l(...args)),
    count: (event) => (listeners.get(event) ?? []).length
  }
}

const harness = () => {
  let holds = 0
  let releases = 0
  const hold = createWindowHold(() => {
    holds += 1
    return () => void (releases += 1)
  })
  return { hold, taken: () => holds, released: () => releases }
}

describe('leavesDocument — which navigations end the page', () => {
  it('a main-frame navigation to another document does; a hash change and a subframe do not', () => {
    expect(leavesDocument({ isMainFrame: true, isSameDocument: false })).toBe(true)
    expect(leavesDocument({ isMainFrame: true, isSameDocument: true })).toBe(false)
    expect(leavesDocument({ isMainFrame: false, isSameDocument: false })).toBe(false)
    expect(leavesDocument(undefined)).toBe(false)
  })
})

describe('createWindowHold — one named pair per hold, removed with it', () => {
  it('subscribing takes the hold once and binds exactly one listener per event, however often the box opens', () => {
    const h = harness()
    const contents = fakeContents()
    h.hold.subscribe(contents)
    h.hold.subscribe(contents)
    h.hold.subscribe(contents)
    expect(h.taken()).toBe(1)
    expect(h.hold.held()).toBe(true)
    expect(contents.count('did-start-navigation')).toBe(1)
    expect(contents.count('destroyed')).toBe(1)
  })

  it('the unsubscribe releases the hold and unbinds both handlers', () => {
    const h = harness()
    const contents = fakeContents()
    h.hold.subscribe(contents)
    h.hold.release()
    expect(h.released()).toBe(1)
    expect(h.hold.held()).toBe(false)
    expect(contents.count('did-start-navigation')).toBe(0)
    expect(contents.count('destroyed')).toBe(0)
    // a second release is a no-op, not a double release
    h.hold.release()
    expect(h.released()).toBe(1)
  })

  it('a hash change or an iframe navigation leaves the hold in place', () => {
    const h = harness()
    const contents = fakeContents()
    h.hold.subscribe(contents)
    contents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.fire('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(h.hold.held()).toBe(true)
    expect(h.released()).toBe(0)
    expect(contents.count('did-start-navigation')).toBe(1)
  })

  it('a reload (main frame, new document) releases the hold and unbinds the pair', () => {
    const h = harness()
    const contents = fakeContents()
    h.hold.subscribe(contents)
    contents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(h.hold.held()).toBe(false)
    expect(h.released()).toBe(1)
    expect(contents.count('did-start-navigation')).toBe(0)
    expect(contents.count('destroyed')).toBe(0)
  })

  it('a destroyed webContents releases the hold', () => {
    const h = harness()
    const contents = fakeContents()
    h.hold.subscribe(contents)
    contents.fire('destroyed')
    expect(h.hold.held()).toBe(false)
    expect(h.released()).toBe(1)
    expect(contents.count('did-start-navigation')).toBe(0)
  })

  it('open, close, open again: the listener count never grows past one', () => {
    const h = harness()
    const contents = fakeContents()
    for (let i = 0; i < 20; i += 1) {
      h.hold.subscribe(contents)
      h.hold.release()
    }
    h.hold.subscribe(contents)
    expect(contents.count('did-start-navigation')).toBe(1)
    expect(contents.count('destroyed')).toBe(1)
    expect(h.taken()).toBe(21)
    expect(h.released()).toBe(20)
  })
})
