import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { RemotePrompt } from '../src/renderer/src/prompt/RemotePrompt'
import { parseRemoteCards } from '../src/renderer/src/zoom/remote-machine'
import { remotePlace, remoteSeen } from '../src/renderer/src/zoom/remote-machine-store'

/**
 * THE BAR'S BOX INSIDE ANOTHER MACHINE, DRAWN (owner 2026-11-12): the same
 * prompt box as this machine's (cr-prompt), saying which machine its words go to.
 */

const SOLIS = { id: 'solis', name: 'Solis-Core', os: 'linux' }
const cards = parseRemoteCards({
  workspaces: [{ id: 'w-1', name: 'Box Lab', active: true }],
  cards: [{ id: 't-1', name: 'Herdr Env', preset: 'claude', status: 'idle', workspace: { id: 'w-1', name: 'Box Lab' }, choice: null, items: [] }]
})!.cards

afterEach(() => remotePlace.leave())

describe('RemotePrompt', () => {
  it('outside every machine: nothing (this machine’s own box is there)', () => {
    expect(renderToStaticMarkup(createElement(RemotePrompt))).toBe('')
  })

  it('in a workspace there: this machine’s prompt box, starting a new agent on that machine', () => {
    remotePlace.enter(SOLIS)
    remotePlace.workspace({ id: 'w-1', name: 'Box Lab' })
    remoteSeen.note({ cards, front: { id: 'w-1', name: 'Box Lab' }, refresh: () => undefined })
    const html = renderToStaticMarkup(createElement(RemotePrompt))
    expect(html).toContain('class="cr-prompt cr-prompt-remote to-new')
    expect(html).toContain('Start a new agent in Box Lab on Solis-Core…')
    expect(html).toContain('＋ Solis-Core')
  })

  it('an agent’s card open: the box is that agent’s, its face in the chip', () => {
    remotePlace.enter(SOLIS)
    remotePlace.workspace({ id: 'w-1', name: 'Box Lab' })
    remotePlace.agent({ id: 't-1', name: 'Herdr Env' })
    remoteSeen.note({ cards, front: null, refresh: () => undefined })
    const html = renderToStaticMarkup(createElement(RemotePrompt))
    expect(html).toContain('to-agent')
    expect(html).toContain('Reply to Herdr Env on Solis-Core…')
    expect(html).toContain('<b>Herdr Env</b>')
  })

  it('the bar holds it in place of this machine’s box while inside another machine', () => {
    const dock = readFileSync('src/renderer/src/Dock.tsx', 'utf8')
    expect(dock).toContain('{!slidIn && insideMachine && <RemotePrompt />}')
    expect(dock).toContain('{!slidIn && !insideMachine && <GlobalPrompt ')
  })
})
