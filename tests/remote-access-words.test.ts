// EVERY STATE IS ONE SENTENCE AND THE NEXT THING TO DO, AND THE WORDS MATCH
// WHERE THE READER IS AND WHAT THEY WILL SEE IN SYSTEM SETTINGS.
import { describe, expect, it } from 'vitest'
import {
  hostWords,
  lastSeenWords,
  LINUX_NO_XDOTOOL,
  XDOTOOL_INSTALL,
  parseRemoteState,
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

  it('a grant macOS has not applied yet is named, so nobody goes round in circles', () => {
    expect(remoteView(state('needs-screen-recording'), 'here').note).toContain('next starts')
    expect(remoteView(state('needs-screen-recording'), 'away').note).toBeNull()
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

  it('a locked Mac offers an unlock to a reader away from it, and only there', () => {
    const away = remoteView(state('locked'), 'away')
    expect(away.title).toContain('locked')
    expect(away.needsYouThere).toBe(false)
    expect(ids(away)).toEqual(['unlock', 'check-again'])
    const here = remoteView(state('locked'), 'here')
    expect(here.needsYouThere).toBe(true)
    expect(ids(here)).toEqual(['check-again'])
  })

  it('a locked Linux machine offers no unlock: the hand is a Mac one', () => {
    expect(ids(remoteView({ ...state('locked'), platform: 'linux' }, 'away'))).toEqual(['check-again'])
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

  it('xdotool stands where Accessibility would: one sentence naming the line, no System Settings', () => {
    for (const where of ['here', 'away'] as const) {
      const view = remoteView(state('needs-accessibility', { platform: 'linux' }), where)
      expect(view.title).toBe('xdotool is missing')
      expect(view.sentence).toBe(LINUX_NO_XDOTOOL)
      expect(view.sentence).toContain(XDOTOOL_INSTALL)
      expect(ids(view)).toEqual(['check-again'])
      expect(view.needsYouThere).toBe(where === 'away')
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

describe('hostWords: what the Mac itself says while someone is on it', () => {
  const row = (who: string, mode: 'watching' | 'controlling', cardName = 'Main display') => ({ key: who, who, card: 'c', cardName, mode, since: 0 })

  it('nobody on it says nothing', () => {
    expect(hostWords({ rows: [], awake: false })).toBeNull()
  })

  it('names who and what, and says when the Mac is being held awake', () => {
    const words = hostWords({ rows: [row('Pixel 9', 'watching')], awake: true })
    expect(words?.line).toBe('Pixel 9 is watching Main display')
    expect(words?.awake).toBe('Keeping this Mac awake while it is watched')
    expect(words?.short).toBe('Pixel 9')
  })

  it('control outranks watching in the line, and the rest are counted', () => {
    const words = hostWords({ rows: [row('iPad', 'watching'), row('Pixel 9', 'controlling'), row('Velvet', 'controlling', 'Safari')], awake: true })
    expect(words?.line).toBe('Pixel 9 is controlling Main display, and 2 more')
    expect(words?.rows).toEqual(['Pixel 9 is controlling Main display', 'Velvet is controlling Safari', 'iPad is watching Main display'])
  })

  it('says machine on a machine', () => {
    expect(hostWords({ rows: [row('Pixel 9', 'watching')], awake: true }, 'linux')?.awake).toBe('Keeping this machine awake while it is watched')
  })
})

describe('a build listed under what started it', () => {
  const fromTerminal: RemoteBuild = { ...source, settingsName: 'iTerm', startedFrom: 'iTerm' }
  const read = (id: 'needs-screen-recording' | 'needs-accessibility', build: RemoteBuild): string =>
    remoteView({ id, platform: 'darwin', build, then: null, detail: null, lastSeenAt: null, until: null, waiting: false }, 'here').sentence

  it('names the row that is really there, and says why it is not Cookrew', () => {
    const sentence = read('needs-screen-recording', fromTerminal)
    expect(sentence).toContain('Turn on iTerm in')
    expect(sentence).toContain('this source build under iTerm')
  })

  it('says the switch is wider than Cookrew: everything started from there gets it', () => {
    expect(read('needs-accessibility', fromTerminal)).toContain('everything started from iTerm')
  })

  it('an app listed under its own name is told no such story', () => {
    expect(read('needs-screen-recording', packaged)).not.toContain('started')
  })

  it('survives the wire, and a bad value is dropped rather than drawn', () => {
    const state = { id: 'needs-screen-recording', platform: 'darwin', build: fromTerminal, then: null, detail: null, lastSeenAt: null, until: null, waiting: false }
    expect(parseRemoteState(state)?.build.startedFrom).toBe('iTerm')
    expect(parseRemoteState({ ...state, build: { ...fromTerminal, startedFrom: 7 } })?.build.startedFrom).toBeNull()
  })
})
