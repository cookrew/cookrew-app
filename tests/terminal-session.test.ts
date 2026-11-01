// TERMINALS FROM AN EARLIER LOGIN (owner, 2026-11-01: aws_mfa_refresh failed in a
// Cookrew terminal and worked in iTerm). Every terminal is a child of the
// detached herdr server, which outlives Cookrew by design — and so can outlive
// the macOS login it started in. Its panes then sit in that login's dead Mach
// namespace: no host name resolves, launchctl answers 141, `open` fails. The
// app now says so: the server started before this login's loginwindow.
import { describe, expect, it } from 'vitest'
import { parsePs, terminalSessionOf } from '../src/main/terminal-session'

const UID = 501
// Measured on the owner's Mac (2026-11-01), trimmed.
const PS = [
  '    1     0     0 Fri Oct 30 01:27:02 2026     /sbin/launchd',
  ' 1201     1   501 Fri Oct 30 01:28:09 2026     /Users/drej/.local/bin/herdr server',
  '67051     1    88 Sat Oct 31 20:28:39 2026     /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon',
  '67061     1   501 Sat Oct 31 20:28:41 2026     /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow console',
  '67886  2980   501 Sun Nov  1 13:30:29 2026     herdr agent attach cookrew_x',
  ' 2980 68165   501 Sun Nov  1 09:12:00 2026     /Users/drej/workspace/cookrew-dev/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .'
].join('\n')

describe('reading ps', () => {
  it('takes pid, parent, user, start time (a one-digit day too) and the command line', () => {
    const rows = parsePs(PS)
    expect(rows).toHaveLength(6)
    expect(rows[1]).toMatchObject({ pid: 1201, ppid: 1, uid: 501, args: '/Users/drej/.local/bin/herdr server' })
    expect(rows[1].startedAt).toBe(new Date(2026, 9, 30, 1, 28, 9).getTime())
    expect(rows[4].startedAt).toBe(new Date(2026, 10, 1, 13, 30, 29).getTime())
  })
})

describe('terminals from an earlier login', () => {
  it('the herdr server is older than this login: stale, with both times and its pid', () => {
    expect(terminalSessionOf(parsePs(PS), UID)).toEqual({
      stale: true,
      serverPid: 1201,
      serverStartedAt: new Date(2026, 9, 30, 1, 28, 9).getTime(),
      loginAt: new Date(2026, 9, 31, 20, 28, 41).getTime()
    })
  })

  it('a server started in this login is fine', () => {
    const fresh = PS.replace('Fri Oct 30 01:28:09 2026', 'Sat Oct 31 21:00:00 2026')
    expect(terminalSessionOf(parsePs(fresh), UID).stale).toBe(false)
  })

  it("only the detached server counts, not herdr's clients, nor another user's", () => {
    const noServer = PS.split('\n').filter((l) => !l.includes('herdr server')).join('\n')
    expect(terminalSessionOf(parsePs(noServer), UID)).toMatchObject({ stale: false, serverPid: null })
    expect(terminalSessionOf(parsePs(PS), 502)).toMatchObject({ stale: false, loginAt: null })
  })

  it('the newest of the user\'s loginwindows is this login', () => {
    const two = `${PS}\n  400     1   501 Fri Oct 30 01:27:30 2026     /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow console`
    expect(terminalSessionOf(parsePs(two), UID).loginAt).toBe(new Date(2026, 9, 31, 20, 28, 41).getTime())
  })
})
