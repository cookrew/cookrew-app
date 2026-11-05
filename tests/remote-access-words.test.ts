// EVERY STATE IS ONE SENTENCE AND THE NEXT THING TO DO, AND THE WORDS MATCH
// WHERE THE READER IS AND WHAT THEY WILL SEE IN SYSTEM SETTINGS.
import { describe, expect, it } from 'vitest'
import {
  lastSeenWords,
  remoteView,
  restartConfirm,
  type RemoteBuild,
  type RemoteState,
  type RemoteStateId
} from '../src/shared/remote-access'

const source: RemoteBuild = { settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }
const packaged: RemoteBuild = { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' }

const state = (id: RemoteStateId, more: Partial<RemoteState> = {}): RemoteState => ({
  id, platform: 'darwin', build: packaged, then: null, detail: null, lastSeenAt: null, until: null, waiting: false, ...more
})
const ids = (view: { actions: ReadonlyArray<{ id: string }> }): string[] => view.actions.map((a) => a.id)

describe('remoteView · at the Mac', () => {
  it('Screen Recording names the row System Settings shows and offers the jump, then Check again', () => {
    const view = remoteView(state('needs-screen-recording'), 'here')
    expect(view.sentence).toContain('Turn on Cookrew')
    expect(view.sentence).toContain('Screen & System Audio Recording')
    expect(ids(view)).toEqual(['open-screen-settings', 'check-again'])
    expect(view.actions[0].label).toBe('Open System Settings')
    expect(view.needsYouThere).toBe(false)
  })

  it('a source build is told to look for Electron, because that is what the list says', () => {
    const view = remoteView(state('needs-screen-recording', { build: source }), 'here')
    expect(view.sentence).toContain('Electron')
    expect(view.sentence).not.toContain('Turn on Cookrew')
    expect(remoteView(state('needs-accessibility', { build: source }), 'here').sentence).toContain('Electron')
  })

  it('a grant waiting on a relaunch offers the restart, and the confirmation is about the agents', () => {
    const view = remoteView(state('needs-restart'), 'here')
    expect(ids(view)).toEqual(['restart', 'check-again'])
    expect(view.actions[0].label).toBe('Restart Cookrew')
    expect(view.actions[0].confirm?.sentence).toContain('Agents keep running')
  })

  it('a build that cannot relaunch itself says what to do instead, with no button that pretends', () => {
    const view = remoteView(state('needs-restart', { build: source }), 'here')
    expect(ids(view)).toEqual(['check-again'])
    expect(view.sentence).toContain('npm run dev')
  })

  it('Accessibility is only ever the jump and Check again', () => {
    expect(ids(remoteView(state('needs-accessibility'), 'here'))).toEqual(['open-accessibility-settings', 'check-again'])
  })

  it('a locked Mac needs someone there, wherever the reader is, and offers no way to unlock', () => {
    for (const where of ['here', 'away'] as const) {
      const view = remoteView(state('locked'), where)
      expect(view.title).toContain('locked')
      expect(view.needsYouThere).toBe(true)
      expect(ids(view)).toEqual(['check-again'])
    }
  })

  it('says what comes after the lock, so nobody finds out at the Mac', () => {
    const view = remoteView(state('locked', { then: 'needs-screen-recording' }), 'away')
    expect(view.next).toContain('Screen Recording')
  })

  it('asleep and unreachable say which, and when it was last seen', () => {
    const at = 1_000_000_000
    const asleep = remoteView(state('display-asleep', { lastSeenAt: at - 13 * 3_600_000 }), 'away', at)
    const gone = remoteView(state('unreachable', { lastSeenAt: at - 5 * 60_000 }), 'away', at)
    expect(asleep.title).toContain('asleep')
    expect(asleep.sentence).toContain('13 h ago')
    expect(gone.title).toContain('reach')
    expect(gone.sentence).toContain('5 min ago')
  })

  it('a closed window keeps its way on: the screen, or another window', () => {
    expect(ids(remoteView(state('window-closed', { detail: "The 'Safari' window closed" }), 'here'))).toEqual(['show-the-screen', 'pick-another'])
  })
})

describe('remoteView · away from the Mac', () => {
  it('says so plainly, and the settings button is honest about where it lands', () => {
    const view = remoteView(state('needs-screen-recording'), 'away')
    expect(view.sentence).toContain('needs you at the Mac')
    expect(view.needsYouThere).toBe(true)
    expect(view.actions[0].label).toBe('Open it on the Mac for later')
    expect(view.actions.map((a) => a.label)).not.toContain('Open System Settings')
  })

  it('says the Mac is holding it open once it was asked', () => {
    const view = remoteView(state('needs-screen-recording', { waiting: true }), 'away')
    expect(view.note).toContain('tell you')
  })

  it('a restart works from here on a build that can do it, and warns about the view', () => {
    const view = remoteView(state('needs-restart'), 'away')
    expect(ids(view)).toEqual(['restart', 'check-again'])
    expect(view.actions[0].confirm?.sentence).toContain('Agents keep running')
    expect(view.actions[0].confirm?.sentence).toContain('this view')
  })

  it('a source build away from the Mac has no restart at all', () => {
    const view = remoteView(state('needs-restart', { build: source }), 'away')
    expect(ids(view)).toEqual(['check-again'])
    expect(view.sentence).toContain('needs you at the Mac')
  })

  it('stopped at the Mac says who decided, and when it can be opened again', () => {
    const view = remoteView(state('stopped', { until: 1_000_000_000 + 600_000 }), 'away', 1_000_000_000)
    expect(view.sentence).toContain('at the Mac')
    expect(view.sentence).toContain('10 min')
  })
})

describe('remoteView · a Linux machine', () => {
  it('never mentions System Settings and calls it a machine', () => {
    const linux = { ...packaged, settingsName: 'Cookrew' }
    const all: RemoteStateId[] = ['locked', 'display-asleep', 'unreachable', 'stopped']
    for (const id of all) {
      const view = remoteView(state(id, { platform: 'linux', build: linux, until: 1 }), 'away')
      expect(`${view.title} ${view.sentence}`).not.toMatch(/System Settings|\bMac\b/)
    }
  })

  it('an unsupported session is its own sentence and no button', () => {
    const view = remoteView(state('unsupported', { platform: 'linux', detail: 'This Linux session runs Wayland' }), 'here')
    expect(view.sentence).toContain('Wayland')
    expect(view.actions).toEqual([])
  })
})

describe('restartConfirm', () => {
  it('tells the truth about each host', () => {
    expect(restartConfirm(packaged, 'here').sentence).toContain('Agents keep running')
    expect(restartConfirm(packaged, 'here').sentence).toContain('interrupted')
    const served = restartConfirm({ ...packaged, agents: 'keep-not-served' }, 'here').sentence
    expect(served).toContain('Agents keep running')
    expect(served).toContain('Served sessions')
    const direct = restartConfirm({ ...packaged, agents: 'stop' }, 'here').sentence
    expect(direct).toContain('stops them')
    expect(direct).not.toContain('keep running')
  })
})

describe('lastSeenWords', () => {
  const now = 1_000_000_000
  it('reads in the unit a person would use', () => {
    expect(lastSeenWords(now - 20_000, now)).toBe('last seen just now')
    expect(lastSeenWords(now - 5 * 60_000, now)).toBe('last seen 5 min ago')
    expect(lastSeenWords(now - 13 * 3_600_000, now)).toBe('last seen 13 h ago')
    expect(lastSeenWords(now - 3 * 86_400_000, now)).toBe('last seen 3 days ago')
  })
  it('does not invent a time it does not have', () => {
    expect(lastSeenWords(null, now)).toBe('not seen yet from here')
  })
})
