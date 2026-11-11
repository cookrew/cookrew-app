// THE LAUNCH SETTINGS SHEET: what a launch line said, as controls.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LaunchSettingsView, type LaunchSettingsViewProps } from '../src/renderer/src/LaunchSettingsSheet'
import { LAUNCH_DEFAULTS } from '../src/shared/launch-settings'

const STATUS = { values: LAUNCH_DEFAULTS, running: LAUNCH_DEFAULTS, pinned: [], restart: false, signedIn: false }

const render = (over: Partial<LaunchSettingsViewProps> = {}): string =>
  renderToStaticMarkup(
    <LaunchSettingsView
      draft={LAUNCH_DEFAULTS}
      status={STATUS}
      saved={false}
      error={null}
      busy={false}
      onDraft={() => undefined}
      onSave={() => undefined}
      onReset={() => undefined}
      onClose={() => undefined}
      {...over}
    />
  )

describe('LaunchSettingsView', () => {
  it('shows the four settings at their defaults', () => {
    const html = render()
    // The registry's API host: cookrew.dev itself is a static site since 0.6.0.
    expect(html).toContain('value="https://api.cookrew.dev"')
    expect(html).toContain('Run workspaces independently')
    expect(html).toContain('Run pages in Chrome')
    expect(html).toMatch(/<option value="herdr" selected/)
    expect(html.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2)
  })

  it('says when a change takes effect', () => {
    expect(render()).toContain('next time Cookrew starts')
  })

  it('says what moving host does to running agents, and the button names it', () => {
    expect(render()).not.toContain('a turn in progress is lost')
    expect(render()).not.toContain('Save and move agents')
    const html = render({ draft: { ...LAUNCH_DEFAULTS, multiplexer: 'tmux' } })
    expect(html).toContain('a turn in progress is lost')
    expect(html).toContain('Save and move agents')
  })

  it('keeps the warning after saving, because the move is still to come', () => {
    const values = { ...LAUNCH_DEFAULTS, multiplexer: 'tmux' }
    expect(render({ draft: values, status: { ...STATUS, values, restart: true } })).toContain('a turn in progress is lost')
  })

  it('says a direct host ends agents with the app, and promises no fallback it does not need', () => {
    const html = render({ draft: { ...LAUNCH_DEFAULTS, multiplexer: 'direct' } })
    expect(html).toContain('Agents end when Cookrew quits or its window closes')
    expect(html).not.toContain('falls back')
  })

  it('moves an agent when its workspace opens, not all at once', () => {
    expect(render({ draft: { ...LAUNCH_DEFAULTS, multiplexer: 'tmux' } })).toContain('when its workspace next opens')
  })

  it('has nothing to move off a direct host: those agents ended with the app', () => {
    const running = { ...LAUNCH_DEFAULTS, multiplexer: 'direct' }
    const html = render({ status: { ...STATUS, values: running, running } })
    expect(html).not.toContain('a turn in progress is lost')
    expect(html).not.toContain('Save and move agents')
  })

  it('says the registry carries served crews as well as the account and phones', () => {
    expect(render()).toContain('served crews')
  })

  it('leads the workspace switch with what it does', () => {
    expect(render()).toContain('holds one workspace at a time')
    expect(render()).toContain('agents there keep running')
  })

  it('says what pages do either way: agents can use them both ways, a phone cannot', () => {
    const html = render()
    expect(html).toContain('Off: pages live in this window')
    expect(html).toContain('a phone only sees pictures of them')
    expect(html).toContain('without one this stays off')
  })

  it('locks what a variable set, and names the variable', () => {
    const html = render({ status: { ...STATUS, pinned: ['multiplexer'] } })
    expect(html).toMatch(/<select[^>]*disabled/)
    expect(html).toContain('COOKREW_MULTIPLEXER')
    expect(html).not.toContain('COOKREW_REGISTRY')
  })

  it('still shows a host name it does not know, when a variable set it', () => {
    const values = { ...LAUNCH_DEFAULTS, multiplexer: 'custom' }
    const html = render({ draft: values, status: { ...STATUS, values, running: values, pinned: ['multiplexer'] } })
    expect(html).toMatch(/<option value="custom" selected/)
  })

  it('holds the registry while signed in, and says how to change it', () => {
    expect(render()).not.toContain('Sign out')
    const html = render({ status: { ...STATUS, signedIn: true } })
    expect(html).toMatch(/<input[^>]*id="launch-registry"[^>]*disabled/)
    expect(html).toContain('Sign out')
  })

  it('asks for a restart once one is needed', () => {
    const values = { ...LAUNCH_DEFAULTS, multiInstance: false }
    expect(render()).not.toContain('Restart Cookrew')
    expect(render({ draft: values, status: { ...STATUS, values, restart: true } })).toContain('Restart Cookrew')
  })

  it('confirms a save that needs no restart', () => {
    expect(render()).not.toContain('Saved.')
    expect(render({ saved: true })).toContain('Saved.')
  })

  it('does not say saved over edits that are not', () => {
    const status = { ...STATUS, restart: true }
    expect(render({ status, saved: true, draft: { ...LAUNCH_DEFAULTS, multiInstance: false } })).not.toContain('Saved')
  })

  it('shows what went wrong', () => {
    expect(render({ error: 'nope' })).toContain('role="alert"')
  })
})
