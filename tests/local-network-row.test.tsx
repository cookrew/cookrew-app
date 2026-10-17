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
