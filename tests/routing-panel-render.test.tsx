// R1 · THE ROUTING PANEL, PAINTED.
//
// The markup is the picture, so the picture can be asserted: the status line
// in its three colours, the plugin's own sentence when it did the wiring, a
// missing tick drawn as the button that types its line, the Add menu's four
// lines, the default picker with groups first, and the one thing the panel
// never contains — a field for a key.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RoutingEntry, RoutingPanel, markRoutingSeen, shouldAutoOpen, ROUTING_SEEN_KEY } from '../src/renderer/src/routing/RoutingPanel'
import { keyLineFor } from '../src/shared/route-lines'
import { findSetupCard, setupCardPosition } from '../src/renderer/src/routing/use-setup-terminal'
import { cardRouteFixture, localTurnFixture, routeFixture } from '../src/shared/route-fixture'
import { decisionFacts, harnessTicks, maskAccount, quotaBar, routeChoices, routeDialAllowed, routeDialLines, statusLine, windowLabel } from '../src/shared/route-view'
import type { RouteState } from '../src/shared/route'
import type { WorkspaceState } from '../src/shared/model'

const NAMES = new Map([
  ['forge', 'Forge'],
  ['tinker', 'Tinker'],
  ['orch', 'Orch']
])

function paint(state: RouteState | null, over: Partial<React.ComponentProps<typeof RoutingPanel>> = {}): string {
  return renderToStaticMarkup(
    <RoutingPanel
      open
      onClose={() => {}}
      state={state}
      available
      onRun={() => {}}
      setupTerminalId={null}
      focusTick={0}
      onSetDefault={() => {}}
      onAddToDock={() => {}}
      names={NAMES}
      {...over}
    />
  )
}

describe('the status line', () => {
  it('is red with one INSTALL button that types the install line when nothing is installed', () => {
    const html = paint(routeFixture('absent'))
    expect(html).toContain('cr-routing-status absent')
    expect(html).toContain('not installed')
    expect(html).toContain('INSTALL · curl -fsSL https://usemagpie.ai/install.sh | sh')
    // No gateway, no accounts, no live routes: the sections say so instead of drawing nothing.
    expect(html).toContain('NO GATEWAY')
    expect(html).not.toContain('Live routes')
  })

  it('is red with START when Magpie is known but /api/hello refuses', () => {
    const html = paint(routeFixture('offline'))
    expect(html).toContain('cr-routing-status offline')
    expect(html).toContain('START · magpie autostart on')
    expect(html).toContain('gateway offline')
  })

  it('is green, names the port, the providers and the default, with no button at all', () => {
    const html = paint(routeFixture('online'))
    expect(html).toContain('cr-routing-status online')
    expect(html).toContain('127.0.0.1:3425 · 3 providers · 2 groups · default group/smart')
    expect(html).not.toContain('cr-routing-btn primary" title=')
  })

  it('says the plugin wired it when the gateway came from the plugin file', () => {
    expect(paint(routeFixture('online'))).toContain('wired by Magpie plugin · ~/.cookrew/magpie.json')
    const probed = { ...routeFixture('online'), gateway: { ...routeFixture('online').gateway!, source: 'probe' as const } }
    expect(paint(probed)).toContain('found on this machine')
    expect(paint(probed)).not.toContain('wired by Magpie plugin')
  })

  it('has no connect button in any state', () => {
    for (const status of ['absent', 'offline', 'online'] as const) {
      expect(paint(routeFixture(status)).toLowerCase()).not.toContain('connect')
    }
  })
})

describe('harness rows', () => {
  it('draws a missing tick as the button that types its line', () => {
    const html = paint(routeFixture('online'))
    expect(html).toContain('✓ installed')
    expect(html).toContain('install · curl -fsSL https://opencode.ai/install | bash')
    expect(html).toContain('add to dock')
  })

  it('draws sign-in as the line the harness owns, and no sign-in at all for a harness without one', () => {
    const ticks = harnessTicks(routeFixture('offline').harnesses[1])
    expect(ticks[1]).toMatchObject({ ok: false, line: 'codex login' })
    const pi = harnessTicks(routeFixture('online').harnesses[3])
    expect(pi[1]).toMatchObject({ ok: true, label: 'no sign-in' })
  })
})

describe('models and accounts', () => {
  it('shows a quota bar per subscription, the gateway’s own label, a sentence for a row it could not read, local · free for a local one', () => {
    const [claude, codex, deepseek, ollama] = routeFixture('online').quotas.map(quotaBar)
    // The gateway could not read Claude's usage: the sentence, no bar.
    expect(claude).toMatchObject({ fill: null, error: "Claude Code's /usage is temporarily unavailable" })
    // The fullest window wears the gateway's own label ("77 / 100"), not a recomputed percent.
    expect(codex).toMatchObject({ fill: 0.77, reading: 'week 77 / 100', error: null })
    expect(deepseek).toMatchObject({ fill: null, reading: 'key' })
    expect(ollama).toMatchObject({ fill: null, reading: 'local · free' })
    // A window with no limit is a counter, shown as the count; with both numbers and no label, a percent.
    expect(windowLabel({ used: 1840, limit: null, display: null })).toBe('1840')
    expect(windowLabel({ used: 41, limit: 100, display: null })).toBe('41%')
    expect(windowLabel({ used: 0, limit: 130, display: '0 / 130' })).toBe('0 / 130')
    expect(windowLabel({ used: null, limit: 100, display: null })).toBe('—')
    const html = paint(routeFixture('online'))
    expect(html).toContain('Claude Max')
    expect(html).toContain("Claude Code&#x27;s /usage is temporarily unavailable")
    expect(html).toContain('width:77%')
    expect(html).toContain('local · free')
    expect(html).not.toContain('resets')
  })

  it('shows an account as its local part and an ellipsis, never the whole email — the phone draws the same row', () => {
    expect(maskAccount('drej@example.com')).toBe('drej@…')
    expect(maskAccount(null)).toBeNull()
    expect(maskAccount('key …3f2a')).toBe('key …3f2a')
    const html = paint(routeFixture('online'))
    expect(html).toContain('drej@…')
    expect(html).not.toContain('example.com')
  })

  it('offers one Add with four lines, and the key line ends in a space for the paste', () => {
    const html = paint(routeFixture('online'))
    expect(html).toContain('ADD ▾')
    const setup = routeFixture('online').setup
    expect(setup.addKeyLine).toBe('magpie provider add ')
    expect(keyLineFor(setup.addKeyLine, 'openrouter')).toBe('magpie provider add openrouter ')
    expect(keyLineFor(setup.addKeyLine, 'kimi')!.endsWith(' ')).toBe(true)
    // A stem of another shape is refused rather than guessed — the user
    // would otherwise paste the key as the provider's NAME.
    expect(keyLineFor('magpie provider add deepseek ', 'kimi')).toBeNull()
    expect(keyLineFor('magpie provider add ', 'Kimi K2')).toBeNull()
  })

  it('never contains a password or key field', () => {
    const html = paint(routeFixture('online'))
    expect(html).not.toMatch(/type="password"/)
    expect(html).not.toMatch(/<input/)
  })

  it('picks the default over the catalogue with groups first, and says direct when none is set', () => {
    expect(routeChoices(routeFixture('online').models).slice(0, 3)).toEqual(['direct', 'group/smart', 'group/opus-anywhere'])
    const html = paint(routeFixture('online'))
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('>group/smart<')
    const none = paint({ ...routeFixture('online'), defaultModel: null })
    expect(none).toContain('direct — pick a model to route new cards')
  })
})

describe('live routes and the rented row', () => {
  it('lists the last decisions as card → group → model, named', () => {
    const html = paint(routeFixture('online'))
    expect(html).toContain('>Forge<')
    expect(html).toContain('>group/smart<')
    expect(html).toContain('>deepseek/deepseek-v4<')
    expect(html).toContain('claude rested · 429')
  })

  it('keeps the rented row read-only and says subscriptions are not lent', () => {
    const html = paint(routeFixture('online'))
    expect(html).toContain('subscriptions not lent by default')
    expect(html).toContain('read-only')
  })
})

describe('the setup card and the entry', () => {
  it('says where the Setup card will appear until it exists, then shows its screen', () => {
    expect(paint(routeFixture('online'))).toContain('appears on the canvas the first time')
    expect(paint(routeFixture('online'), { setupTerminalId: 't-setup' })).toContain('cr-routing-screen')
  })

  it('finds the Setup card by name and preset, and lands a new one beside the board', () => {
    const ws = {
      nodes: [
        { kind: 'terminal', id: 'a', name: 'Setup', preset: 'Claude Code', position: { x: 0, y: 0 }, size: { width: 640, height: 420 } },
        { kind: 'terminal', id: 'b', name: 'Setup', preset: 'Shell', position: { x: 700, y: 110 }, size: { width: 640, height: 420 } }
      ]
    } as unknown as WorkspaceState
    expect(findSetupCard(ws)?.id).toBe('b')
    expect(findSetupCard(null)).toBeNull()
    expect(setupCardPosition(ws)).toEqual({ x: 1540, y: 0 })
  })

  it('wears the gateway lamp in the header and opens by itself once, only while nothing is installed', () => {
    expect(renderToStaticMarkup(<RoutingEntry status="online" onOpen={() => {}} />)).toContain('cr-routing-entry online')
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(shouldAutoOpen('online', storage)).toBe(false)
    expect(shouldAutoOpen('absent', storage)).toBe(true)
    // Deciding to open burns nothing — only a panel actually on screen does.
    expect(store.has(ROUTING_SEEN_KEY)).toBe(false)
    expect(shouldAutoOpen('absent', storage)).toBe(true)
    markRoutingSeen(storage)
    expect(store.has(ROUTING_SEEN_KEY)).toBe(true)
    expect(shouldAutoOpen('absent', storage)).toBe(false)
  })

  it('shows why a default pick or a Setup line did nothing, as one line under the status', () => {
    expect(paint(routeFixture('online'), { error: 'setup line unexpected — not typed' })).toContain('setup line unexpected')
  })

  it('renders nothing while closed, and says so on a bridge without routing', () => {
    expect(paint(routeFixture('online'), { open: false })).toBe('')
    expect(paint(null, { available: false })).toContain('NOT ON THIS BRIDGE')
  })
})

describe('what the rail will say (route-view)', () => {
  it('reads direct, routed with this turn, restart, and offline', () => {
    expect(routeDialLines(cardRouteFixture({ route: 'direct', effective: null, live: null, turn: null })).value).toBe('direct')
    const routed = routeDialLines(cardRouteFixture())
    expect(routed.turn).toBe('this turn → deepseek/deepseek-v4 · 11.3k in · 1.1k out · $0.018')
    expect(routeDialLines(cardRouteFixture({ appliesOn: 'restart' })).note).toBe('applies on restart')
    expect(routeDialLines(cardRouteFixture({ offline: true })).value).toBe('direct')
    expect(routeDialLines(cardRouteFixture({ offline: true })).note).toBe('gateway offline · direct')
  })

  it('never offers a route dial to a served session (design D3)', () => {
    expect(routeDialAllowed({ remote: false, served: false })).toBe(true)
    expect(routeDialAllowed({ remote: true, served: false })).toBe(false)
    expect(routeDialAllowed({ remote: false, served: true })).toBe(false)
  })

  it('spells the status sentence from the state and not from a guess', () => {
    expect(statusLine(routeFixture('absent')).action?.label).toBe('INSTALL')
    expect(statusLine(routeFixture('online')).action).toBeNull()
  })

  it('says why it is not routing when main says so, and offers no INSTALL — the owner fixes the file', () => {
    const refused = routeFixture('absent', { why: 'the plugin file names a gateway off this machine (http://10.0.0.9:3425)' })
    const line = statusLine(refused)
    expect(line.text).toBe('not routing — the plugin file names a gateway off this machine (http://10.0.0.9:3425)')
    expect(line.action).toBeNull()
    const html = paint(refused)
    expect(html).toContain('not routing —')
    expect(html).not.toContain('INSTALL ·')
  })

  it('reads a turn on a local model as local, never $0.00, with tokens in and out', () => {
    expect(routeDialLines(localTurnFixture()).turn).toBe('this turn → ollama/qwen3:32b · 1.8k in · 312 out · local')
    expect(routeDialLines(cardRouteFixture()).turn).toBe('this turn → deepseek/deepseek-v4 · 11.3k in · 1.1k out · $0.018')
    expect(routeDialLines(localTurnFixture()).turn).not.toContain('$')
  })

  it('carries main’s note under the value — codex needs a thinking-capable model', () => {
    const lines = routeDialLines(cardRouteFixture({ route: 'deepseek/deepseek-v4', note: 'codex needs a thinking-capable model behind the gateway' }))
    expect(lines.note).toBe('codex needs a thinking-capable model behind the gateway')
    expect(routeDialLines(cardRouteFixture({ appliesOn: 'restart', note: 'codex needs a thinking-capable model behind the gateway' })).note).toBe('applies on restart · codex needs a thinking-capable model behind the gateway')
  })

  it('says tries, failures and the first-token time on a live row', () => {
    const base = routeFixture('online').live[0]
    expect(decisionFacts(base)).toBe('first token 2.3 s')
    expect(decisionFacts({ ...base, tries: 2, status: 'claude rested · 429', ttftMs: 4100 })).toBe('2 tries · claude rested · 429 · first token 4.1 s')
    // The gateway's own array, each try with a `fail`, is read the same way.
    expect(decisionFacts({ ...base, tries: [{ model: 'a', fail: 'rate limited' }, { model: 'b' }] as unknown as number, status: null, ttftMs: null })).toBe('2 tries · 1 failed')
    expect(decisionFacts({ ...base, ttftMs: null })).toBe('first pick')
    const html = paint(routeFixture('online'))
    expect(html).toContain('first token 2.3 s')
    expect(html).toContain('2 tries · claude rested · 429')
  })
})
