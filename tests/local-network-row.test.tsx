// THE ONE-LINE EXPLAINER, AND WHAT THE BADGE SAYS AFTER A REFUSAL.
//
// A permission prompt with no sentence in front of it is a dialog about
// "192-168-1-24.<a uuid>.d.cookrew.dev" wanting the local network, which reads
// as an attack. So the ask is explained in the reader's own terms first, in
// one line, with one button — and the explainer is the ONLY place the prompt
// is raised from, because it is the only moment somebody is looking.
//
// The refusal has to be said out loud too. "RELAY — your Mac is not on this
// network" is a lie when the Mac is three feet away and the browser simply
// will not let us knock, and it is the exact lie that fills a support forum.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LOCAL_NETWORK_COPY } from '../src/renderer/src/path-copy'

afterEach(() => vi.resetModules())

const row = async (state: 'prompt' | 'denied' | 'granted' | 'unsupported'): Promise<string> => {
  vi.resetModules()
  const gate = await import('../src/renderer/src/local-network-gate')
  const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
  gate.resetLocalNetworkGate()
  gate.offerLocalNetwork(async () => undefined)
  gate.setLocalNetwork(state)
  return renderToStaticMarkup(<LocalNetworkRow />)
}

describe('the explainer', () => {
  it('asks in one sentence, with one button, when the browser will prompt', async () => {
    const markup = await row('prompt')
    expect(markup).toContain('This phone can talk to the Mac directly on this Wi-Fi.')
    expect(markup).toContain('Allow local network access?')
    expect(markup).toContain('>Allow</button>')
  })

  it('says what happened after a refusal, and where to undo it', async () => {
    const markup = await row('denied')
    expect(markup).toContain('Staying on the relay.')
    expect(markup).toContain('site settings')
    // Nothing to press: the browser will not re-prompt, and a dead button is
    // worse than no button.
    expect(markup).not.toContain('</button>')
  })

  it('is not there at all when there is nothing to ask', async () => {
    expect(await row('granted')).toBe('')
    expect(await row('unsupported')).toBe('')
  })

  it('is not offered before the switcher is wired, so it cannot ask into a void', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
    gate.resetLocalNetworkGate()
    gate.setLocalNetwork('prompt')
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toBe('')
  })
})

// THE PRESS SPENDS THE ASK (the owner's Android, Chrome 155, 2026-11-02).
//
// The phone reported RELAY with the permission at 'prompt' after every press:
// the Mac's LAN name timed out from that phone, so the annotated request never
// reached an address Chrome could ask about, no dialog was raised, and the row
// stayed — with its button greyed for the ask's 30 s deadline, then lit again.
// The press is the reader's answer. The row goes on the press, and a 'prompt'
// that raised nothing does not bring it back on the next load.
describe('the press', () => {
  const memoryStorage = (): Storage => {
    const items = new Map<string, string>()
    return {
      get length() {
        return items.size
      },
      clear: () => items.clear(),
      getItem: (key) => items.get(key) ?? null,
      key: (index) => [...items.keys()][index] ?? null,
      removeItem: (key) => void items.delete(key),
      setItem: (key, value) => void items.set(key, String(value))
    }
  }

  afterEach(() => vi.unstubAllGlobals())

  const load = async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
    return { gate, LocalNetworkRow }
  }

  it('hides the row the moment it is pressed, before the browser answers', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const { gate, LocalNetworkRow } = await load()
    gate.resetLocalNetworkGate()
    let finish: () => void = () => undefined
    gate.offerLocalNetwork(() => new Promise<void>((resolve) => void (finish = resolve)))
    gate.setLocalNetwork('prompt')
    const seen: string[] = []
    gate.subscribeLocalNetwork(() => seen.push('told'))

    const pending = gate.acceptLocalNetwork()
    expect(gate.localNetworkAsked()).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toBe('')
    finish()
    await pending
    // Still 'prompt': nothing was raised, and nothing is offered again.
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toBe('')
  })

  it('stays spent across a reload of the page', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const first = await load()
    first.gate.resetLocalNetworkGate()
    first.gate.offerLocalNetwork(async () => undefined)
    first.gate.setLocalNetwork('prompt')
    await first.gate.acceptLocalNetwork()

    const second = await load()
    second.gate.offerLocalNetwork(async () => undefined)
    second.gate.setLocalNetwork('prompt')
    expect(renderToStaticMarkup(<second.LocalNetworkRow />)).toBe('')
  })

  it('still says where the switch is when the press ended in a refusal', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const { gate, LocalNetworkRow } = await load()
    gate.resetLocalNetworkGate()
    gate.offerLocalNetwork(async () => gate.setLocalNetwork('denied'))
    gate.setLocalNetwork('prompt')
    await gate.acceptLocalNetwork()
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toContain('Staying on the relay.')
  })

  it('asks again once the spent press is a month old', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const { gate, LocalNetworkRow } = await load()
    gate.resetLocalNetworkGate()
    storage.setItem(gate.LOCAL_NETWORK_ASKED_KEY, String(Date.now() - gate.LOCAL_NETWORK_ASK_AGAIN_MS - 1))
    const fresh = await load()
    fresh.gate.offerLocalNetwork(async () => undefined)
    fresh.gate.setLocalNetwork('prompt')
    expect(renderToStaticMarkup(<fresh.LocalNetworkRow />)).toContain('>Allow</button>')
  })

  it('works without storage at all, for the life of the page', async () => {
    vi.stubGlobal('localStorage', undefined)
    const { gate, LocalNetworkRow } = await load()
    gate.resetLocalNetworkGate()
    gate.offerLocalNetwork(async () => undefined)
    gate.setLocalNetwork('prompt')
    await gate.acceptLocalNetwork()
    expect(renderToStaticMarkup(<LocalNetworkRow />)).toBe('')
  })
})
