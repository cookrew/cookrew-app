// REMOTE DESKTOP, OFFERED ON DAY ONE (first-run/RemoteRows.tsx): optional, and it says
// plainly what it allows. Both system permissions have a press of their own.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RemoteRowsView, remoteSteps, type RemoteRowsViewProps } from '../src/renderer/src/first-run/RemoteRows'
import { REMOTE_SETUP_COPY } from '../src/shared/first-run-copy'
import type { RemoteAccess, RemoteBuild, RemoteState, RemoteStateId } from '../src/shared/remote-access'

const build: RemoteBuild = { settingsName: 'Cookrew', startedFrom: null, sourceBuild: false, restart: 'self', agents: 'keep' } as RemoteBuild
const state = (id: RemoteStateId, over: Partial<RemoteState> = {}): RemoteState => ({ id, platform: 'darwin', build, then: null, detail: null, lastSeenAt: null, until: null, waiting: false, ...over })
const access = (id: RemoteStateId, control: Partial<RemoteAccess['control']> = {}, over: Partial<RemoteState> = {}): RemoteAccess => ({
  state: state(id, over),
  control: { available: true, switchOn: false, accessibility: false, ...control }
})

const draw = (over: Partial<RemoteRowsViewProps> = {}): string =>
  renderToStaticMarkup(
    <RemoteRowsView
      access={access('needs-screen-recording')}
      busy={false}
      said={null}
      onOpen={vi.fn()}
      onRestart={vi.fn()}
      onSwitch={vi.fn()}
      {...over}
    />
  )

describe('remoteSteps', () => {
  it('reads each permission on its own', () => {
    expect(remoteSteps(access('needs-screen-recording'))).toEqual({ screen: 'off', accessibility: 'off', on: false })
    expect(remoteSteps(access('ready', { accessibility: true, switchOn: true }))).toEqual({ screen: 'on', accessibility: 'on', on: true })
  })

  it('a grant macOS has not applied yet needs a restart, not another trip to Settings', () => {
    expect(remoteSteps(access('needs-restart')).screen).toBe('restart')
  })

  it('reads through a lock, a sleeping display and what comes after them', () => {
    expect(remoteSteps(access('locked', {}, { then: 'needs-screen-recording' })).screen).toBe('off')
    expect(remoteSteps(access('locked', {}, { then: 'needs-restart' })).screen).toBe('restart')
    expect(remoteSteps(access('locked')).screen).toBe('on')
    expect(remoteSteps(access('display-asleep')).screen).toBe('on')
  })
})

describe('the section', () => {
  it('offers it, and says it is optional', () => {
    const html = draw()
    expect(html).toContain(REMOTE_SETUP_COPY.HEAD)
    expect(html).toContain('Optional')
  })

  it('has both permissions, by the names System Settings uses', () => {
    const html = draw()
    expect(html).toContain('Screen &amp; System Audio Recording')
    expect(html).toContain('Accessibility')
  })

  it('a permission that is off has a press that opens it', () => {
    const onOpen = vi.fn()
    const html = draw({ onOpen })
    expect(html.match(/class="fr-fix"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).toContain(REMOTE_SETUP_COPY.ALLOW)
  })

  it('a permission that is on has nothing to press', () => {
    const html = draw({ access: access('ready', { accessibility: true }) })
    expect(html).not.toContain(`>${REMOTE_SETUP_COPY.ALLOW}<`)
    expect(html.match(/fr-row found/g)).toHaveLength(2)
  })

  it('names the row to turn on: from a terminal it is the terminal, not Cookrew', () => {
    const iterm = access('needs-screen-recording', {}, { build: { ...build, settingsName: 'iTerm' } })
    expect(draw({ access: iterm })).toContain('Turn on iTerm')
  })

  it('says what to do when Settings shows it on and this says off: a new build no longer matches the old row', () => {
    expect(draw()).toContain(REMOTE_SETUP_COPY.STALE)
    expect(draw({ access: access('ready', { accessibility: true }) })).not.toContain(REMOTE_SETUP_COPY.STALE)
  })

  it('offers a restart when that is all that is left', () => {
    const html = draw({ access: access('needs-restart', { accessibility: true }) })
    expect(html).toContain(REMOTE_SETUP_COPY.RESTART_NEEDED)
    expect(html).toContain(REMOTE_SETUP_COPY.RESTART)
  })

  it('a build that cannot restart itself offers no press it cannot keep', () => {
    const byHand = access('needs-restart', {}, { build: { ...build, restart: 'by-hand' } })
    expect(draw({ access: byHand })).not.toContain(`>${REMOTE_SETUP_COPY.RESTART}<`)
  })

  it('the switch says all of what it allows, agents included', () => {
    expect(REMOTE_SETUP_COPY.SWITCH_DOES).toMatch(/unlock/)
    expect(REMOTE_SETUP_COPY.SWITCH_DOES).toMatch(/agents/i)
    expect(REMOTE_SETUP_COPY.SWITCH_DOES).toMatch(/restart/)
    expect(REMOTE_SETUP_COPY.SWITCH_DOES).toMatch(/awake/)
    expect(draw()).toContain(REMOTE_SETUP_COPY.TURN_ON)
    expect(draw({ access: access('ready', { switchOn: true, accessibility: true }) })).toContain(REMOTE_SETUP_COPY.TURN_OFF)
  })

  it('shows what the last press said', () => {
    expect(draw({ said: 'Remote control stays off.' })).toContain('Remote control stays off.')
  })

  it('every press waits its turn', () => {
    const html = draw({ busy: true })
    expect(html.match(/class="fr-fix"[^>]*disabled/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('the wiring', () => {
  it('sits on the tool check, under the ways in, and stands in nobody\'s way', () => {
    const preflight = readFileSync('src/renderer/src/first-run/Preflight.tsx', 'utf8')
    expect(preflight.indexOf('<AccessRows')).toBeLessThan(preflight.indexOf('<RemoteRows'))
    expect(preflight).not.toMatch(/mayContinue\([^)]*remote/i)
  })
})
