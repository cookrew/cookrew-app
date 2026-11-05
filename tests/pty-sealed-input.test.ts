// A HIDDEN PROMPT HIDES NOTHING FROM THE APP. `cookrew login` reads its password
// with echo off, so nothing reaches the screen, the scrollback or a transcript.
// But the keys still pass through PtySession.write, which announces every byte
// to the turn tracker: in an agent's pane the password and Enter opened a turn
// with the password as its prompt. A sealed pane still delivers the keys and
// tells nobody.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const procWrites: string[] = []

vi.mock('node-pty', () => ({
  default: {
    spawn: () => ({
      write: (data: string) => procWrites.push(data),
      resize: () => undefined,
      kill: () => undefined,
      onData: () => undefined,
      onExit: () => undefined
    })
  }
}))

import { PtySession, setBackends, setMultiplexer } from '../src/main/pty'
import { TurnTracker } from '../src/main/turn-tracker'
import { defaultProducerLease } from '../src/main/producer-lease'
import type { Multiplexer } from '../src/main/multiplexer'

const PASSWORD = 'SENTINEL-hunter2-do-not-keep'

const fakeMux = {
  id: 'fake',
  capabilities: {
    persistsAcrossRestart: false,
    copyModeSearch: false,
    wheelScrollback: false,
    agentLifecycle: false
  },
  available: () => true,
  sessionExists: () => false,
  ensureSession: () => undefined,
  attachSpawn: () => ({ file: '/bin/true', args: [], env: {} }),
  killSession: () => undefined,
  listSessions: () => [],
  scrollState: () => ({ scrollRow: null, historySize: null }),
  jumpToText: () => undefined,
  exitCopyMode: () => undefined,
  panePid: () => null,
  paneLaunch: () => null,
  reloadConfig: () => undefined
} as unknown as Multiplexer

const makeSession = (terminalId = 'term-sealed'): PtySession => {
  setMultiplexer(fakeMux)
  setBackends([])
  return new PtySession({ terminalId, command: 'zsh', cwd: '/tmp', socketPath: '/tmp/x.sock', cliDir: '/tmp' })
}

const heard = (session: PtySession): string[] => {
  const inputs: string[] = []
  session.on('input', (data: string) => inputs.push(data))
  return inputs
}

beforeEach(() => {
  procWrites.length = 0
})

describe('a sealed pane', () => {
  it('delivers the keys and announces none of them', () => {
    const session = makeSession()
    const inputs = heard(session)
    const release = session.sealInput()
    session.write(`${PASSWORD}\r`)
    expect(procWrites).toEqual([`${PASSWORD}\r`])
    expect(inputs).toEqual([])
    release()
    session.dispose()
  })

  it('announces again once released, and a second release changes nothing', () => {
    const session = makeSession()
    const inputs = heard(session)
    const release = session.sealInput()
    release()
    release()
    session.write('ls\r')
    expect(inputs).toEqual(['ls\r'])
    session.dispose()
  })

  it('stays sealed until the last holder lets go', () => {
    const session = makeSession()
    const inputs = heard(session)
    const first = session.sealInput()
    const second = session.sealInput()
    first()
    session.write('still sealed')
    expect(inputs).toEqual([])
    second()
    session.write('open')
    expect(inputs).toEqual(['open'])
    session.dispose()
  })

  it('marks no owner input: the keys went to a prompt, not to the box', () => {
    const lease = defaultProducerLease()
    const mark = vi.spyOn(lease, 'noteBytesEntering')
    const session = makeSession()
    const release = session.sealInput()
    session.write('x')
    session.writeFromOwner('y')
    expect(mark).not.toHaveBeenCalled()
    release()
    mark.mockRestore()
    session.dispose()
  })

  it('still answers to the owner guard: a refused key is refused', () => {
    const session = makeSession()
    session.beforeOwnerInput = () => 'refused'
    const release = session.sealInput()
    expect(session.write('x')).toBe('refused')
    expect(procWrites).toEqual([])
    release()
    session.dispose()
  })

  it('takes the owner prompt box the same way', () => {
    const session = makeSession()
    const inputs = heard(session)
    const release = session.sealInput()
    expect(session.writeFromOwner(PASSWORD)).toBe(true)
    expect(procWrites).toEqual([PASSWORD])
    expect(inputs).toEqual([])
    release()
    session.dispose()
  })

  it('refuses a dispatch: no other agent types into a hidden prompt', () => {
    const session = makeSession()
    const inputs = heard(session)
    const release = session.sealInput()
    expect(session.writeFromDispatch('a brief\r')).toBe(false)
    expect(procWrites).toEqual([])
    expect(inputs).toEqual([])
    release()
    session.dispose()
  })

  it('hears nothing a backend reports either', () => {
    const session = makeSession()
    const inputs = heard(session)
    const release = session.sealInput()
    session.noteExternalInput('said server-side\r')
    expect(inputs).toEqual([])
    release()
    session.dispose()
  })
})

describe('the turn tracker, and why this exists', () => {
  const tracked = (id: string): { tracker: TurnTracker; session: PtySession } => {
    const tracker = new TurnTracker(async () => null, null)
    const session = makeSession(id)
    tracker.track(session, true)
    return { tracker, session }
  }

  it('reads an unsealed Enter in an agent pane as a prompt, password and all', () => {
    const { tracker, session } = tracked('term-open')
    session.write(`${PASSWORD}\r`)
    expect(JSON.stringify(tracker.list())).toContain(PASSWORD)
    tracker.disposeAll()
    session.dispose()
  })

  it('never sees a sealed one: no turn, no draft, nothing on the card', () => {
    const { tracker, session } = tracked('term-closed')
    const release = session.sealInput()
    session.write(PASSWORD)
    expect(JSON.stringify(tracker.list())).not.toContain(PASSWORD)
    session.write('\r')
    expect(JSON.stringify(tracker.list())).not.toContain(PASSWORD)
    expect(tracker.list()[0]?.phase).toBe('idle')
    release()
    // Nothing was held back to be replayed when the seal lifted.
    expect(JSON.stringify(tracker.list())).not.toContain(PASSWORD)
    tracker.disposeAll()
    session.dispose()
  })
})
