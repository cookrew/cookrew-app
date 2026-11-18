// YOUR COMPUTERS, DRAWN (routing/DevicesGuide.tsx): four steps, an install line
// per computer for its own system, Use its Magpie held back until both switches
// are on and the computer is online, and no key anywhere on the page.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DevicesGuideView } from '../src/renderer/src/routing/DevicesGuide'
import type { MagpieRemoteState } from '../src/renderer/src/routing/magpie-remote-store'

const state = (over: Partial<MagpieRemoteState> = {}): MagpieRemoteState => ({
  list: {
    signedIn: true,
    forwarder: 3428,
    sealed: true,
    problem: null,
    desktopsKnown: true,
    desktops: [
      { id: 'aaaaaaaaaaaa', name: 'Solis-Core', online: true, providerId: null, os: 'linux', arch: 'x64' },
      { id: 'bbbbbbbbbbbb', name: 'Laptop', online: false, providerId: null, os: 'darwin', arch: 'arm64' }
    ]
  },
  readProblem: null,
  busy: [],
  problems: {},
  ...over
})

const render = (s: MagpieRemoteState, switches = { magpie: true, magpieRemote: true }): string =>
  renderToStaticMarkup(<DevicesGuideView state={s} switches={switches} modelHere={false} onUse={() => {}} onStop={() => {}} onAccount={() => {}} />)

describe('the devices guide', () => {
  it('draws the four steps and each computer’s own install lines', () => {
    const html = render(state())
    for (const step of ['computers', 'agents', 'model', 'use']) expect(html).toContain(`data-step="${step}"`)
    expect(html).toContain('curl -fsSL https://claude.ai/install.sh | bash')
    expect(html).toContain('codex-x86_64-unknown-linux-musl')
    expect(html).toContain('codex-aarch64-apple-darwin')
    expect(html).toContain('Add a computer')
  })

  it('offers Use its Magpie for an online computer, and not for an offline one', () => {
    const html = render(state())
    expect(html).toMatch(/data-peer="aaaaaaaaaaaa"[\s\S]*?<button[^>]*class="cr-routing-btn primary"[^>]*>Use its Magpie/)
    expect(html).toMatch(/data-peer="bbbbbbbbbbbb"[\s\S]*?<button[^>]*disabled=""[^>]*>Use its Magpie/)
  })

  it('holds Use back and says why while Magpie remote is off', () => {
    const html = render(state(), { magpie: true, magpieRemote: false })
    expect(html).toContain('Turn on Magpie and Magpie remote')
    expect(html).toMatch(/data-peer="aaaaaaaaaaaa"[\s\S]*?disabled=""[^>]*>Use its Magpie/)
  })

  it('says a computer is in use, with its models’ name, and a way to stop', () => {
    const s = state()
    const html = render({ ...s, list: { ...(s.list as NonNullable<typeof s.list>), desktops: [{ ...(s.list as NonNullable<typeof s.list>).desktops[0], providerId: 'solis-core' }] } })
    expect(html).toContain('models as solis-core/…')
    expect(html).toContain('Stop using')
  })

  it('shows a failed try beside its computer, the forwarder’s port taken, and a sign-in first', () => {
    expect(render(state({ problems: { aaaaaaaaaaaa: 'Magpie remote is switched off on Solis-Core.' } }))).toContain('switched off on Solis-Core')
    const s = state()
    expect(render({ ...s, list: { ...(s.list as NonNullable<typeof s.list>), forwarder: null } })).toContain('port 3428')
    expect(render({ ...s, list: { ...(s.list as NonNullable<typeof s.list>), signedIn: false, desktops: [] } })).toContain('Sign in first')
  })

  it('never draws a key', () => {
    expect(render(state())).not.toMatch(/sk-magpie|cookrew-sealed/)
  })
})
