// One SSE event is parsed once, not once per subscriber.
//
// Measured on the phone over real CDP: the 'workspace' payload is 520,160 bytes
// on the owner's board and three components subscribe to it (App, EventToast,
// DirectoryManager). The parse lived inside the per-listener callback, so every
// broadcast cost roughly 2 MB of JSON parsing and left four independent object
// graphs of the whole board alive at once. EventToast paid half a megabyte of
// that to read one string, s.name.
//
// The assertion that matters is "N listeners, one parse". Asserted against the
// real function, with no conditional skips — a test that returns early when a
// seam is missing passes against a broken implementation, which is worse than
// having no test.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseOnce } from '../src/renderer/src/remote-api'

afterEach(() => vi.restoreAllMocks())

const event = (data: string): MessageEvent => new MessageEvent('workspace', { data })

describe('parseOnce', () => {
  it('parses one event a single time however many listeners read it', () => {
    // The defect in one assertion: this was 4 before.
    const spy = vi.spyOn(JSON, 'parse')
    const e = event('{"name":"Cookrew Dev","nodes":[]}')
    for (let i = 0; i < 4; i += 1) parseOnce(e)

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('hands every listener the SAME object rather than private copies', () => {
    // Four copies of a 520 KB board is the memory half of the bug; one shared
    // object is the fix. These consumers only read — the desktop IPC path
    // already shared one object, so a subscriber that mutated was already broken.
    const e = event('{"name":"a"}')
    expect(parseOnce(e)).toBe(parseOnce(e))
  })

  it('never serves one event\'s parse for a different event', () => {
    // Keyed on the event object. Sharing across events would paint a stale
    // board over a fresh one — far worse than the cost it saves.
    const first = parseOnce<{ name: string }>(event('{"name":"first"}'))
    const second = parseOnce<{ name: string }>(event('{"name":"second"}'))

    expect(first.name).toBe('first')
    expect(second.name).toBe('second')
  })

  it('parses each distinct event exactly once — no cross-event bleed', () => {
    const spy = vi.spyOn(JSON, 'parse')
    parseOnce(event('{"a":1}'))
    parseOnce(event('{"a":2}'))

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('propagates a malformed payload instead of caching a bad result', () => {
    // A throw must not poison the cache: the next listener has to see the same
    // failure, not undefined served from a half-populated entry.
    const bad = event('{ not json')
    expect(() => parseOnce(bad)).toThrow()
    expect(() => parseOnce(bad)).toThrow()
  })
})
