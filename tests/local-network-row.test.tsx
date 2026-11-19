// THE LOCAL-NETWORK ROW IS GONE, AND THE GATE ASKS NOTHING.
//
// THE ASK WENT FIRST (2026-11-16). Its button raised Chrome's prompt with a
// request to one of the Mac's names under d.cookrew.dev; those names are
// dropped, so there is no address left to aim an ask at and no button.

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.resetModules())

describe('the row', () => {
  // GONE (2026-11-19, review of the names removal). With no names, the direct
  // path is the WebRTC link, which the local-network permission does not gate:
  // "Staying on the relay" under a refusal would blame a setting that changes
  // nothing, even under a badge reading LAN. The permission is still read, for
  // the path report the Mac keeps (path/companion.ts).
  it('is not drawn: no module, no copy, and the header does not ask for one', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync('src/renderer/src/LocalNetworkRow.tsx')).toBe(false)
    expect(existsSync('src/renderer/src/path-copy.ts')).toBe(false)
    expect(readFileSync('src/renderer/src/Header.tsx', 'utf8')).not.toMatch(/LocalNetworkRow/)
    expect(readFileSync('src/renderer/src/styles.css', 'utf8')).not.toMatch(/\.cr-path-ask/)
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
