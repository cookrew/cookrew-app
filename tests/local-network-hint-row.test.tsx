// WHAT THE EXPLAINER MAY SAY ONCE THE PROBE HAS FALLEN BACK.
//
// THE INCIDENT: Chrome 152 behind a system proxy, on the owner's Mac,
// 2026-09-08. The permission read 'prompt' for ever — no dialog was raised and
// none could be, because the annotated request fails Local Network Access
// before any prompt when a proxy hides the resolved address. The row went on
// offering ALLOW, which is a button that cannot do anything: there is no
// pending permission behind it.
//
// Two different right answers, and they are opposite:
//
//   THE PROBE GOT THROUGH WITHOUT THE HINT. There is nothing left to allow.
//   The session is already direct. The row goes away.
//
//   THE BROWSER REFUSED IT BOTH WAYS. The permission is still worth asking for
//   — this may simply be a browser that has not been asked — but the sentence
//   has to name the proxy, and the one thing that definitely works is opening
//   the Mac's own Wi-Fi address.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LOCAL_NETWORK_COPY } from '../src/renderer/src/path-copy'
import { localNetworkAskRow } from '../src/renderer/src/path/hint-evidence'
import type { PathAttempt } from '../src/renderer/src/path-attempts'

const attempt = (over: Partial<PathAttempt> = {}): PathAttempt => ({
  name: '192.168.2.40:8643',
  outcome: 'blocked',
  ms: 32,
  plane: 'LAN',
  chosen: false,
  ...over
})

const askRow = (over: Parameters<typeof localNetworkAskRow>[0]): ReturnType<
  typeof localNetworkAskRow
> => localNetworkAskRow(over)

afterEach(() => vi.resetModules())

describe('the decision behind the row', () => {
  it('asks in the ordinary way when the race says nothing about a hint', () => {
    const view = askRow({ permission: 'prompt', offered: true, attempts: [attempt()] })
    expect(view.kind).toBe('ask')
    expect(view.sentence).toBe(LOCAL_NETWORK_COPY.ask)
  })

  it('hides itself once something answered without the hint', () => {
    // The permission is still 'prompt' and will stay 'prompt' for ever. There
    // is no pending grant behind the button, and the session is already direct.
    const view = askRow({
      permission: 'prompt',
      offered: true,
      attempts: [attempt({ outcome: 'answered', ms: 41, hint: 'none', chosen: true })]
    })
    expect(view.kind).toBe('hidden')
  })

  it('names the proxy when every candidate was refused both ways', () => {
    const view = askRow({
      permission: 'prompt',
      offered: true,
      attempts: [attempt({ hint: 'none' })]
    })
    expect(view.kind).toBe('ask')
    expect(view.sentence).toContain(LOCAL_NETWORK_COPY.ask)
    expect(view.sentence).toContain('A system proxy may be hiding the address')
    expect(view.sentence).toContain('Wi-Fi address directly')
  })

  it('does not name a proxy when only one of several was refused both ways', () => {
    const view = askRow({
      permission: 'prompt',
      offered: true,
      attempts: [attempt({ hint: 'none' }), attempt({ name: '10.0.0.9:8643', outcome: 'timeout' })]
    })
    expect(view.sentence).toBe(LOCAL_NETWORK_COPY.ask)
  })

  it('keeps every answer it already had for the other three states', () => {
    const rows = [attempt()]
    expect(askRow({ permission: 'denied', offered: true, attempts: rows })).toEqual({
      kind: 'denied',
      sentence: LOCAL_NETWORK_COPY.denied
    })
    expect(askRow({ permission: 'granted', offered: true, attempts: rows }).kind).toBe('hidden')
    expect(askRow({ permission: 'unsupported', offered: true, attempts: rows }).kind).toBe('hidden')
    // Nowhere to point the ask yet: a prompt raised at no address spends the
    // one grant a reader will ever give on a request that cannot succeed.
    expect(askRow({ permission: 'prompt', offered: false, attempts: rows }).kind).toBe('hidden')
  })
})

describe('the row as it renders', () => {
  const render = async (
    permission: 'prompt' | 'denied',
    attempts: readonly PathAttempt[]
  ): Promise<string> => {
    vi.resetModules()
    const gate = await import('../src/renderer/src/local-network-gate')
    const store = await import('../src/renderer/src/path-attempts')
    const { LocalNetworkRow } = await import('../src/renderer/src/LocalNetworkRow')
    gate.resetLocalNetworkGate()
    store.resetPathAttempts()
    gate.offerLocalNetwork(async () => undefined)
    gate.setLocalNetwork(permission)
    store.recordAttempts(attempts, 'RELAY')
    return renderToStaticMarkup(<LocalNetworkRow />)
  }

  it('still asks, with a button, on an ordinary prompt', async () => {
    const markup = await render('prompt', [attempt()])
    expect(markup).toContain('>Allow</button>')
    expect(markup).not.toContain('system proxy')
  })

  it('renders nothing at all after a hint-less success', async () => {
    const markup = await render('prompt', [attempt({ outcome: 'answered', hint: 'none' })])
    expect(markup).toBe('')
  })

  it('adds the proxy sentence when both variants were refused', async () => {
    const markup = await render('prompt', [attempt({ hint: 'none' })])
    expect(markup).toContain('A system proxy may be hiding the address from the browser')
    expect(markup).toContain('>Allow</button>')
  })

  it('leaves the refusal sentence exactly where it was', async () => {
    const markup = await render('denied', [attempt({ hint: 'none' })])
    expect(markup).toContain('site settings')
    expect(markup).not.toContain('</button>')
  })
})
