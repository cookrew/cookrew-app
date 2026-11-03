// LANE PANEL2, items 1, 3, 4: a Setup line watched until the prompt returns,
// the "routes" tick with the one sentence the dial also reads, and the brief
// drawn under the name. Static markup, the house way (no DOM env).

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LINE_RUNNING, observeOutput, runningLabel, runningView, startedLine } from '../src/renderer/src/routing/setup-line-state'
import { AddMenu, Harnesses, StatusLine } from '../src/renderer/src/routing/RoutingSections'
import { AgentRow } from '../src/renderer/src/AgentRow'
import { NOT_ROUTABLE_REASON, harnessTicks, notRoutableNote, routeDialInput } from '../src/shared/route-view'
import { cardRouteFixture, routeFixture } from '../src/shared/route-fixture'
import { buildAgentRows } from '../src/renderer/src/agent-rows'

const LINE = 'magpie accounts add codex'

describe('a typed Setup line, watched', () => {
  it('is running until the prompt comes back after the echo — an old prompt replayed by the attach does not count', () => {
    let w = startedLine(LINE)
    w = observeOutput(w, '\x1b[90mold output\x1b[0m\r\n~/app $ ')
    expect(w.done).toBe(false)
    w = observeOutput(w, `${LINE}\r\n`)
    expect(w.echoed).toBe(true)
    expect(w.done).toBe(false)
    // Words alone are not a sign-in any more (setup-line-state: "opens at login" fooled them):
    // the button reads the pane's own line until the pane prints the page to open.
    w = observeOutput(w, 'Finish signing in in your browser\r\n')
    expect(runningView(w)).toEqual({ line: LINE, lastLine: 'Finish signing in in your browser', oauth: false, url: null })
    expect(runningLabel(runningView(w), LINE)).toBe('running… Finish signing in in your browser')
    w = observeOutput(w, 'https://auth.openai.com/oauth/authorize?x=1\r\n')
    expect(runningView(w)).toMatchObject({ oauth: true, url: 'https://auth.openai.com/oauth/authorize?x=1' })
    expect(runningLabel(runningView(w), LINE)).toBe('sign in — open the page')
    expect(runningLabel(runningView(w), 'magpie serve')).toBeNull()
    w = observeOutput(w, 'Signed in as drej.\r\n~/app $ ')
    expect(w.done).toBe(true)
  })

  it('reads the pane’s last line while running, and nothing when the pane has only echoed the line', () => {
    const w = observeOutput(startedLine('magpie serve'), 'magpie serve\r\nlistening on 127.0.0.1:3425\r\n')
    expect(runningLabel(runningView(w), 'magpie serve')).toBe('running… listening on 127.0.0.1:3425')
    expect(runningLabel(runningView(observeOutput(startedLine('magpie serve'), 'magpie serve')), 'magpie serve')).toBe('running…')
    expect(LINE_RUNNING).toContain('still running')
  })

  it('the button that typed the line says so and cannot be pressed again; the others stay buttons', () => {
    const state = routeFixture('absent')
    const running = { line: state.setup.installLine, lastLine: 'Downloading magpie 0.1.1182…', oauth: false, url: null }
    const html = renderToStaticMarkup(<StatusLine state={state} onRun={() => {}} running={running} />)
    expect(html).toContain('running… Downloading magpie 0.1.1182…')
    expect(html).toContain('disabled=""')
    const idle = renderToStaticMarkup(<StatusLine state={state} onRun={() => {}} running={null} />)
    expect(idle).not.toContain('disabled=""')
    const online = routeFixture('online')
    const sub = { line: online.setup.addSubscriptionLine, lastLine: 'Finish signing in in your browser', oauth: true, url: 'https://claude.ai/oauth/authorize?x=1' }
    const menu = renderToStaticMarkup(<AddMenu setup={online.setup} onRun={() => {}} defaultOpen running={sub} />)
    expect(menu).toContain('sign in — open the page')
    // Auto group is disabled on its own account here (the fixture sends no auto-group script), so it is left out of the count.
    const disabledItems = [...menu.matchAll(/<button[^>]*disabled=""[^>]*>/g)].filter((m) => !m[0].includes('data-item="auto-group"'))
    expect(disabledItems).toHaveLength(1)
    const rows = renderToStaticMarkup(<Harnesses rows={routeFixture('offline').harnesses} onRun={() => {}} running={{ line: 'codex login', lastLine: 'Opening your browser…', oauth: true, url: 'https://auth.openai.com/oauth/authorize?x=1' }} />)
    expect(rows).toContain('sign in — open the page')
  })
})

describe('the routes tick and the dial say the same thing', () => {
  it('pi gets ✗ routes with the reason as the title; the others get ✓', () => {
    const online = routeFixture('online')
    // pi became routable in core2 (proven on the real binary); the ✗ case is a row main marked not routable.
    const state = { ...online, harnesses: online.harnesses.map((r) => (r.id === 'pi' ? { ...r, routable: false } : r)) }
    const html = renderToStaticMarkup(<Harnesses rows={state.harnesses} onRun={() => {}} />)
    expect(html).toContain(`title="${NOT_ROUTABLE_REASON.pi}"`)
    expect(html).toContain('✗ routes')
    expect(html.match(/✓ routes/g)).toHaveLength(3)
    const pi = state.harnesses.find((r) => r.id === 'pi')!
    expect(harnessTicks(pi).map((t) => t.label)).toEqual(['installed', 'no sign-in', 'in dock', 'routes'])
    expect(harnessTicks(pi)[3]).toMatchObject({ ok: false, why: NOT_ROUTABLE_REASON.pi })
    // Forge's word wins over the table either way.
    expect(harnessTicks({ ...pi, routable: true })[3].ok).toBe(true)
    expect(harnessTicks({ ...state.harnesses[0], routable: false })[3].ok).toBe(false)
  })

  it('the dial line is "direct · <the same reason>", and a card main marked not routable reads its note', () => {
    expect(notRoutableNote('pi')).toBe(`direct · ${NOT_ROUTABLE_REASON.pi}`)
    expect(notRoutableNote('claude')).toBeNull()
    const note = notRoutableNote('pi')!
    expect(routeDialInput({ allowed: true, routeChoices: ['direct', 'group/smart'], state: cardRouteFixture({ routable: false, note }) })).toEqual({ choices: [], notRoutable: note })
    expect(note.endsWith(NOT_ROUTABLE_REASON.pi!)).toBe(true)
  })
})

describe('the brief under the name', () => {
  it('is drawn on the Board row, truncated by CSS, never as an input', () => {
    const rows = buildAgentRows({
      roster: [{ id: 'a1', name: 'Write Haiku About', preset: 'Claude Code', role: null, orch: false, active: true, workspaceId: 'ws', workspaceName: 'Cookrew Dev', cwd: '/x', spawnedAt: 1 } as never],
      activities: {},
      now: 10,
      briefs: { a1: 'write a haiku about cables' }
    })
    const row = rows.quiet[0]
    expect(row.brief).toBe('write a haiku about cables')
    const html = renderToStaticMarkup(<AgentRow row={row} now={10} selected={false} recovering={false} canRecover={false} onOpen={() => {}} onRecover={() => {}} />)
    expect(html).toContain('<span class="cr-brief ags-brief" title="write a haiku about cables">write a haiku about cables</span>')
    expect(html).not.toContain('<input')
    const none = buildAgentRows({ roster: [{ id: 'a2', name: 'Forge', preset: 'Claude Code', role: null, orch: false, active: true, workspaceId: 'ws', workspaceName: 'Cookrew Dev', cwd: '/x', spawnedAt: 1 } as never], activities: {}, now: 10 })
    expect(none.quiet[0].brief).toBeNull()
  })
})
