// CONNECT AN AI ACCOUNT, PAINTED: the four ways, what each press types, the one
// step left once Magpie has models, the launch nudge, and the share section.
// The panel's rule holds here too: no field ever takes a Magpie key.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountWays } from '../src/renderer/src/first-run/AccountWays'
import { AccountNudgeView } from '../src/renderer/src/first-run/AccountNudge'
import { ShareDevicesView } from '../src/renderer/src/routing/ShareDevices'
import { RoutingPanel } from '../src/renderer/src/routing/RoutingPanel'
import { routeFixture } from '../src/shared/route-fixture'
import { setupLineAllowed } from '../src/shared/route-lines'
import type { RouteState } from '../src/shared/route'

const paint = (route: RouteState | null, endpointActive = false): string =>
  renderToStaticMarkup(<AccountWays route={route} endpointActive={endpointActive} onRun={() => {}} running={null} onSetDefault={() => {}} />)

/** Every line a press would type, read off the buttons' titles. */
const linesOf = (html: string): string[] => [...html.matchAll(/title="([^"]+)"/g)].map((m) => m[1].replace(/&#x27;/g, "'"))

describe('AccountWays', () => {
  it('offers all four ways while nothing is connected', () => {
    const html = paint(routeFixture('online', { defaultModel: null, harnesses: [] }))
    expect(html).toContain('Connect an AI account')
    expect(html).toContain('Claude or ChatGPT subscription')
    expect(html).toContain('API key')
    expect(html).toContain('Another computer’s Magpie')
    expect(html).toContain('Agents need an AI account')
  })

  it('types only lines the Setup card accepts', () => {
    for (const status of ['absent', 'offline', 'online'] as const) {
      const lines = linesOf(paint(routeFixture(status, { defaultModel: null })))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(setupLineAllowed(line), line).toBe(true)
    }
  })

  it('signs subscriptions in to Magpie when Magpie is here', () => {
    const lines = linesOf(paint(routeFixture('online', { defaultModel: null })))
    expect(lines).toContain('magpie accounts add claude')
    expect(lines).toContain('magpie accounts add codex')
  })

  it('sends a person without Magpie to install it for keys and another computer', () => {
    const html = paint(routeFixture('absent'))
    expect(html).toContain('Needs Magpie on this computer.')
    expect(linesOf(html)).toContain('curl -fsSL https://usemagpie.ai/install.sh | sh')
  })

  it('offers to start a Magpie that is installed and stopped', () => {
    expect(linesOf(paint(routeFixture('offline')))).toContain('magpie autostart on')
  })

  it('asks for the default model once Magpie has models and none is picked', () => {
    const html = paint(routeFixture('online', { defaultModel: null }))
    expect(html).toContain('One step left')
    expect(html).toMatch(/<select/)
  })

  it('says it is ready once an account counts', () => {
    expect(paint(routeFixture('online', { harnesses: [] }))).toContain('Ready: new agents go through Magpie.')
    expect(paint(null, true)).toContain('Ready: agents run on your own endpoint.')
  })

  it('has no field for a key', () => {
    expect(paint(routeFixture('online', { defaultModel: null }))).not.toMatch(/type="password"/)
  })
})

describe('the Routing panel slots', () => {
  it('draws the guide before the harnesses and the share section after the accounts', () => {
    const html = renderToStaticMarkup(
      <RoutingPanel open onClose={() => {}} state={routeFixture('online')} available onRun={() => {}} setupTerminalId={null} focusTick={0} onSetDefault={() => {}} names={new Map()} guide={<i id="guide-slot" />} share={<i id="share-slot" />} />
    )
    expect(html.indexOf('guide-slot')).toBeGreaterThan(-1)
    expect(html.indexOf('share-slot')).toBeGreaterThan(html.indexOf('guide-slot'))
  })
})

describe('AccountNudgeView', () => {
  it('says what is missing and offers the way and a later', () => {
    const html = renderToStaticMarkup(<AccountNudgeView onOpen={() => {}} onLater={() => {}} />)
    expect(html).toContain('No AI account yet')
    expect(html).toContain('Set one up')
    expect(html).toContain('Not now')
  })
})

describe('ShareDevicesView', () => {
  const base = { problem: null, issued: null, busy: false, onIssue: () => {}, onRevoke: () => {}, onCheck: () => {}, onDone: () => {} }

  it('says Magpie answers only this computer until it is shared on the network', () => {
    const html = renderToStaticMarkup(<ShareDevicesView {...base} keys={[]} where={{ onNetwork: false, urls: ['http://192.168.1.20:3425'] }} />)
    expect(html).toContain('Settings › Gateway')
    expect(html).toContain('http://192.168.1.20:3425')
  })

  it('lists the device keys with their caps and a revoke each', () => {
    const html = renderToStaticMarkup(<ShareDevicesView {...base} keys={[{ id: 'a'.repeat(24), name: 'device-solis', device: 'solis', limit: '$1.25/$20.00 per day' }]} where={{ onNetwork: true, urls: [] }} />)
    expect(html).toContain('solis')
    expect(html).toContain('$1.25/$20.00 per day')
    expect(html).toContain('Revoke')
    expect(html).not.toContain('Settings › Gateway')
  })

  it('shows a new key once, with the way to copy it, and no form beside it', () => {
    const html = renderToStaticMarkup(<ShareDevicesView {...base} keys={[]} where={null} issued={{ key: 'sk-magpie-abcdefabcdefabcdef', device: 'laptop' }} />)
    expect(html).toContain('sk-magpie-abcdefabcdefabcdef')
    expect(html).toContain('shown once')
    expect(html).not.toContain('name="device"')
  })
})

describe('another computer’s Magpie', () => {
  it('opens Magpie’s own settings instead of typing a key line into a terminal', () => {
    const html = renderToStaticMarkup(<AccountWays route={routeFixture('online', { defaultModel: null, harnesses: [] })} endpointActive={false} onRun={() => {}} running={null} switches={{ magpie: true, magpieRemote: true }} showSwitches={false} />)
    expect(html).toMatch(/data-way="remote-magpie"[^>]*>Open Magpie settings/)
    expect(html).toContain('Providers › Add › Remote magpie')
    expect(html).not.toContain('remote-magpie url=')
  })
})

describe('a Remote magpie on loopback, in the Routing panel', () => {
  it('is named with what it risks, and the press that takes it out is an allowed line', () => {
    const html = renderToStaticMarkup(
      <RoutingPanel open onClose={() => {}} state={routeFixture('online', { loopbackRemotes: [{ id: 'solis', port: 13425 }] })} available onRun={() => {}} setupTerminalId={null} focusTick={0} onSetDefault={() => {}} names={new Map()} />
    )
    expect(html).toContain('data-section="loopback-remotes"')
    expect(html).toContain('127.0.0.1:13425')
    expect(html).toContain('Take out solis')
    expect(setupLineAllowed('magpie provider rm solis')).toBe(true)
    expect(renderToStaticMarkup(<RoutingPanel open onClose={() => {}} state={routeFixture('online')} available onRun={() => {}} setupTerminalId={null} focusTick={0} onSetDefault={() => {}} names={new Map()} />)).not.toContain('loopback-remotes')
  })
})

describe('Share with my devices on plain http', () => {
  it('says what plain http risks beside the addresses', () => {
    const html = renderToStaticMarkup(<ShareDevicesView keys={[]} where={{ onNetwork: true, urls: ['http://192.168.1.20:3425'] }} problem={null} issued={null} busy={false} onIssue={() => {}} onRevoke={() => {}} onCheck={() => {}} onDone={() => {}} />)
    expect(html).toContain('data-note="plain-http"')
    expect(html).toContain('Plain http only on a tailnet')
    expect(html).toContain('magpie https on')
  })
})

describe('a Remote magpie on plain http off a tailnet, in the Routing panel', () => {
  it('is named with what it risks', () => {
    const html = renderToStaticMarkup(
      <RoutingPanel open onClose={() => {}} state={routeFixture('online', { plainRemotes: [{ id: 'office', host: '192.168.1.20:3425' }] })} available onRun={() => {}} setupTerminalId={null} focusTick={0} onSetDefault={() => {}} names={new Map()} />
    )
    expect(html).toContain('data-section="plain-remotes"')
    expect(html).toContain('192.168.1.20:3425')
    expect(html).toContain('tailnet address, or https')
  })
})

