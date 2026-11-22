import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RoutingPanel } from '../src/renderer/src/routing/RoutingPanel'
import { AddMenu } from '../src/renderer/src/routing/RoutingSections'
import { ROUTING_COPY } from '../src/shared/route-view'
import { ROUTE_HTTP_SCHEMA_VERSION, type RouteState } from '../src/shared/route'
import { routeFixture } from '../src/shared/route-fixture'

function paint(state: RouteState): string {
  return renderToStaticMarkup(<RoutingPanel
    open available state={state} onClose={() => {}} onRun={() => {}}
    setupTerminalId={null} focusTick={0} names={new Map()}
    onSetDefault={() => {}} onSetSharedMcp={() => {}}
  />)
}

describe('routing panel with a restricted route snapshot', () => {
  it('renders both address-free warnings and keeps default, MCP and harness controls', () => {
    const state = {
      ...routeFixture(), gateway: null, gatewaySource: 'plugin' as const,
      remoteRisks: {
        plain: 'A Remote Magpie connection sends its key and requests unencrypted.',
        loopback: 'A stopped tunnel can expose its key and requests.'
      }
    }
    const html = paint(state)
    expect(html).toContain('role="alert"')
    expect(html).toContain(state.remoteRisks.plain)
    expect(html).toContain(state.remoteRisks.loopback)
    expect(html).toContain('gateway · 3 providers · 2 groups · default group/smart')
    expect(html).toContain('wired by Magpie plugin')
    expect(html).toContain('aria-label="Default route for new cards"')
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>group\/smart<\/button>/)
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>shared<\/button>/)
    expect(html).toContain('install · curl -fsSL https://opencode.ai/install | bash')
    expect(html).toContain('context7')
    expect(html).not.toContain('Take out')
  })

  it('says a filtered-empty library and group line are hidden, not empty', () => {
    const panel = paint({
      ...routeFixture(),
      mcpServers: [],
      setup: { ...routeFixture().setup, addGroupLine: null },
      withheld: { mcpServers: true, addGroupLine: true }
    })
    expect(panel).toContain(ROUTING_COPY.hiddenOnDevice)
    expect(panel).not.toContain('hub shares nothing yet')
    const menu = renderToStaticMarkup(<AddMenu
      setup={{ ...routeFixture().setup, addGroupLine: null }} onRun={() => {}} defaultOpen
      withheld={{ addGroupLine: true }}
    />)
    expect(menu).toContain(ROUTING_COPY.hiddenOnDevice)
    expect(menu).not.toContain(ROUTING_COPY.groupNeedsTwo)
  })

  it('does not claim direct when the default was withheld', () => {
    const html = paint({ ...routeFixture(), defaultModel: null, withheld: { defaultModel: true } })
    expect(html).toContain('default hidden on this device')
    expect(html).not.toContain('direct — pick a model')
    expect(html).not.toMatch(/role="radio" aria-checked="true"[^>]*>direct<\/button>/)
  })

  it('says direct without offering hidden choices when the actual default is null', () => {
    const html = paint({ ...routeFixture(), defaultModel: null, models: [], withheld: { providerData: true } })
    expect(html).toContain('direct · model choices hidden on this device')
    expect(html).not.toContain('direct — pick a model')
    expect(html).not.toMatch(/role="radio"[^>]*>direct<\/button>/)
  })

  it('distinguishes a withheld auto-group line from one that is genuinely missing', () => {
    const setup = { ...routeFixture().setup, addAutoGroupLine: null }
    const draw = (withheld?: RouteState['withheld']) => renderToStaticMarkup(<AddMenu setup={setup} onRun={() => {}} defaultOpen withheld={withheld} />)
    const hidden = draw({ addAutoGroupLine: true })
    expect(hidden).toContain(ROUTING_COPY.hiddenOnDevice)
    expect(hidden).not.toContain(ROUTING_COPY.autoGroupNeedsScript)
    expect(draw()).toContain(ROUTING_COPY.autoGroupNeedsScript)
  })

  it('explains why unproven provider details and model controls are hidden', () => {
    const source = routeFixture()
    const html = paint({ ...source, models: [], quotas: [], live: [], defaultModel: null, withheld: { providerData: true, defaultModel: true } })
    expect(html).toContain('Provider details and model choices are hidden on this device because their source cannot be verified.')
    expect(html).not.toContain('no routed turn yet')
    expect(html).not.toContain('Model catalogue · 0')
    expect(html).not.toContain('default direct')
  })

  it('warns when the private configuration inventory could not be read', () => {
    const html = paint({ ...routeFixture(), models: [], quotas: [], live: [], withheld: { endpointInventory: true } })
    expect(html).toContain('Routing details are hidden on this device because the host configuration could not be read.')
    expect(html).not.toContain('no routed turn yet')
    expect(html).not.toContain('Model catalogue · 0')
    expect(html).not.toContain('0 groups')
    expect(html).toContain('groups hidden on this device')
    expect(html).toContain('Model catalogue · hidden on this device')
    expect(html).toContain('Live routes are hidden on this device')
  })

  it('renders surviving MCP names and a partial redaction notice together', () => {
    const html = paint({ ...routeFixture(), mcpServers: ['memory'], withheld: { mcpServers: true } })
    expect(html).toContain('hub shares memory')
    expect(html).toContain(ROUTING_COPY.hiddenOnDevice)
    expect(html).not.toContain('hub shares nothing yet')
  })

  it('renders neutral hidden text for withheld quota and live-route errors', () => {
    const base = routeFixture()
    const errorQuota = { ...base.quotas[0], error: ROUTING_COPY.hiddenOnDevice }
    const hiddenLive = { ...base.live[0], status: ROUTING_COPY.hiddenOnDevice }
    const html = paint({ ...base, quotas: [errorQuota], live: [hiddenLive] })
    expect(html).toContain(ROUTING_COPY.hiddenOnDevice)
    expect(html).not.toContain(base.quotas[0].error as string)
  })

  it('requires a client upgrade for a route schema newer than this renderer', () => {
    const html = paint({ ...routeFixture(), schemaVersion: ROUTE_HTTP_SCHEMA_VERSION + 1 })
    expect(html).toContain('Update this client to view routing safely')
    expect(html).not.toContain('aria-label="Default route for new cards"')
    expect(html).not.toContain('127.0.0.1:3425')
  })

  it('renders an older shipped payload that has no schemaVersion', () => {
    const legacy = routeFixture()
    expect(legacy).not.toHaveProperty('schemaVersion')
    expect(paint(legacy)).toContain('cr-routing-status online')
  })

  it('still renders detailed warnings and remediation for full IPC and sealed-owner state', () => {
    const html = paint(routeFixture('online', {
      loopbackRemotes: [{ id: 'my-tunnel', port: 54322 }],
      plainRemotes: [{ id: 'my-remote', host: 'remote.example' }]
    }))
    expect(html).toContain('127.0.0.1:3425')
    expect(html).toContain('127.0.0.1:54322')
    expect(html).toContain('Take out my-tunnel')
    expect(html).toContain('remote.example')
  })

  it('keeps install and start actions on restricted snapshots without a remote risk', () => {
    const absent = paint(routeFixture('absent', { gateway: null }))
    const offline = paint(routeFixture('offline', { gateway: null }))
    expect(absent).toContain('INSTALL · curl -fsSL https://usemagpie.ai/install.sh | sh')
    expect(offline).toContain('START · magpie autostart on')
    expect(offline).not.toContain('data-section="remote-risks"')
  })
})
