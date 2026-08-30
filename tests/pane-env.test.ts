import { describe, expect, it } from 'vitest'
import { paneEnv } from '../src/main/pane-env'

/**
 * THE CONTROL PLANE IS THE OWNER'S ALONE.
 *
 * These are not style assertions. The CLI socket takes commands with no
 * credential and honours `--as <any agent>`, so a served pane holding
 * COOKREW_SOCKET can drive the owner's canvas — `recruit --dir <owner dir>
 * --command …` spawns outside the sandbox. Verified live before the fix: a
 * raw connect to that socket returned the global roster of every workspace.
 * The served line makes such a pane interactively reachable by a stranger, so
 * this boundary is asserted here rather than trusted.
 */

const OWNER_ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/owner', SECRET: 'shh' }
const SERVED_ENV = { PATH: '/harness/bin:/usr/bin', HOME: '/sandbox/svc-x-ana-1' }

const owner = (): Record<string, string> =>
  paneEnv({
    terminalId: 't-1',
    socketPath: '/tmp/cookrew-runtime/cookrew.sock',
    cliDir: '/app/cli',
    ownerEnv: OWNER_ENV
  })

const served = (): Record<string, string> =>
  paneEnv({
    terminalId: 't-2',
    socketPath: '/tmp/cookrew-runtime/cookrew.sock',
    cliDir: '/app/cli',
    servedEnv: SERVED_ENV,
    ownerEnv: OWNER_ENV
  })

describe('pane env — the CLI control plane', () => {
  it("the owner's own pane keeps the CLI, exactly as before", () => {
    const env = owner()
    expect(env.COOKREW_SOCKET).toBe('/tmp/cookrew-runtime/cookrew.sock')
    expect(env.COOKREW_CLI).toBe('/app/cli/cookrew')
    expect(env.PATH).toBe('/app/cli:/usr/bin:/bin')
    expect(env.COOKREW_TERMINAL_ID).toBe('t-1')
    expect(env.TERM_PROGRAM).toBe('Cookrew')
  })

  it('a SERVED pane is given no way to reach the socket', () => {
    const env = served()
    expect(env.COOKREW_SOCKET).toBeUndefined()
    expect(env.COOKREW_CLI).toBeUndefined()
    // Not on PATH either: the wrapper reads ~/.cookrew/socket as a fallback,
    // so leaving `cookrew` runnable would hand back what the keys withheld.
    expect(env.PATH).toBe('/harness/bin:/usr/bin')
    expect(env.PATH).not.toContain('/app/cli')
    expect(Object.values(env).some((value) => value.includes('cookrew.sock'))).toBe(false)
  })

  it("a served pane carries the scrub, never the owner's process env", () => {
    const env = served()
    expect(env.SECRET).toBeUndefined()
    expect(env.HOME).toBe('/sandbox/svc-x-ana-1')
    expect(env.COOKREW_TERMINAL_ID).toBe('t-2')
  })

  it('an empty served env is still served — the absence of a PATH is not a fallback', () => {
    const env = paneEnv({
      terminalId: 't-3',
      socketPath: '/tmp/s.sock',
      cliDir: '/app/cli',
      servedEnv: {},
      ownerEnv: OWNER_ENV
    })
    expect(env.COOKREW_SOCKET).toBeUndefined()
    expect(env.PATH).toBe('')
    expect(env.PATH).not.toContain('/usr/bin')
  })
})
