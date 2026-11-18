// WHAT THE ROW UNDER THE BADGE SAYS AFTER A REFUSAL, AND THAT IT ASKS NOTHING.
//
// The refusal has to be said out loud. "RELAY — your Mac is not on this
// network" is a lie when the Mac is three feet away and the browser simply
// will not let us knock, and it is the exact lie that fills a support forum.
//
// THE ASK IS GONE (2026-11-16). Its button raised Chrome's prompt with a
// request to one of the Mac's names under d.cookrew.dev; those names are
// dropped, so there is no address left to aim an ask at and no button.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LOCAL_NETWORK_COPY } from '../src/renderer/src/path-copy'

afterEach(() => vi.resetModules())

const row = async (state: 'prompt' | 'denied' | 'granted' | 'unsupported'): Promise<string> => {
  vi.resetModules()
  const gate = await import('../src/renderer/src/local-network-gate')
  const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
  gate.resetLocalNetworkGate()
  gate.setLocalNetwork(state)
  return renderToStaticMarkup(<LocalNetworkRow />)
}

describe('the row', () => {
  it('says what happened after a refusal, and where to undo it', async () => {
    const markup = await row('denied')
    expect(markup).toContain(LOCAL_NETWORK_COPY.denied.replace("'", '&#x27;'))
    expect(markup).toContain('Staying on the relay.')
    expect(markup).toContain('site settings')
    // Nothing to press: the browser will not re-prompt, and a dead button is
    // worse than no button.
    expect(markup).not.toContain('</button>')
  })

  it('is not there at all in any other state, including one where the browser would prompt', async () => {
    expect(await row('prompt')).toBe('')
    expect(await row('granted')).toBe('')
    expect(await row('unsupported')).toBe('')
  })
})

describe('the gate', () => {
  it('offers nothing to ask with: no offer, no press, no remembered press', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    for (const gone of ['offerLocalNetwork', 'acceptLocalNetwork', 'localNetworkOffered', 'localNetworkAsked', 'LOCAL_NETWORK_ASKED_KEY']) {
      expect(gate, gone).not.toHaveProperty(gone)
    }
  })

  it('tells its listeners when the browser’s answer changes, and only then', async () => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    gate.resetLocalNetworkGate()
    const heard: string[] = []
    gate.subscribeLocalNetwork((next) => void heard.push(next))
    gate.setLocalNetwork('prompt')
    gate.setLocalNetwork('prompt')
    gate.setLocalNetwork('denied')
    expect(heard).toEqual(['prompt', 'denied'])
    expect(gate.localNetworkGate()).toBe('denied')
  })
})
