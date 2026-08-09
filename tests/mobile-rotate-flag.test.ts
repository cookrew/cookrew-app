import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { cmdMobile } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import type { CliRequest } from '../src/shared/model'
import type { MobileEndpoint } from '../src/main/mobile-endpoints'

/**
 * `cookrew mobile --rotate` silently did nothing: it exited 0 and printed the
 * ordinary URL list while revoking NOTHING. cmdMobile tested `args[0] ===
 * '--rotate'`, but the CLI's parseArgv routes every `--token` into `flags` and
 * leaves `args` empty, so the branch was unreachable.
 *
 * Rotation is the only revocation path for a token that now survives restarts,
 * so the failure mode was the worst available: an operator burning a leaked
 * credential gets a success exit and a live token.
 *
 * These tests exercise the CLI→server CONTRACT with request objects shaped the
 * way the CLI actually builds them. The previous coverage asserted that
 * rotateActivePairingToken existed and swapped the in-memory token — it did,
 * perfectly, and nothing reached it. Testing the mechanism is not testing the
 * feature.
 */

const ENDPOINT: MobileEndpoint = {
  url: 'https://host.example.ts.net:8643/?token=t',
  kind: 'tailscale',
  host: 'host.example.ts.net',
  label: 'Tailscale'
}

function deps(): SocketServerDeps & { rotatePairingToken: ReturnType<typeof vi.fn> } {
  return {
    rotatePairingToken: vi.fn(() => 'new-token'),
    mobileEndpoints: () => [ENDPOINT],
    uncoveredCertHosts: () => []
  } as unknown as SocketServerDeps & { rotatePairingToken: ReturnType<typeof vi.fn> }
}

/** Exactly what `cookrew mobile --rotate` puts on the wire. */
function cliRequest(flags: Record<string, string | boolean> = {}): CliRequest {
  return { id: 'r1', terminalId: 't1', cmd: 'mobile', args: [], flags }
}

describe('cookrew mobile --rotate', () => {
  it('ROTATES when the flag arrives the way the CLI sends it', () => {
    const d = deps()
    const out = cmdMobile(cliRequest({ rotate: true }), d)
    expect(d.rotatePairingToken).toHaveBeenCalledTimes(1)
    expect(out).toContain('unpaired')
  })

  it('does NOT rotate on a plain `cookrew mobile`', () => {
    const d = deps()
    const out = cmdMobile(cliRequest(), d)
    expect(d.rotatePairingToken).not.toHaveBeenCalled()
    expect(out).toContain('open on your phone')
  })

  it('ignores an unrelated flag rather than rotating on any flag at all', () => {
    const d = deps()
    cmdMobile(cliRequest({ qr: true }), d)
    expect(d.rotatePairingToken).not.toHaveBeenCalled()
  })

  it('does not rotate on a merely truthy value — only the flag being set', () => {
    // parseArgv yields `true` for a bare flag and a STRING when a value
    // follows it (`--rotate now` → 'now'). Only the bare form is rotation.
    const d = deps()
    cmdMobile(cliRequest({ rotate: 'maybe' }), d)
    expect(d.rotatePairingToken).not.toHaveBeenCalled()
  })
})

describe('the CLI actually produces that shape', () => {
  it('parseArgv routes `--rotate` into flags, never into args', () => {
    // The coupling that broke: cmdMobile cannot see how the CLI parses. Pin
    // the parser's behaviour by running the REAL function out of the shipped
    // CLI, so a change to either side fails here rather than in the field.
    const source = readFileSync('cli/cookrew.mjs', 'utf8')
    const start = source.indexOf('function parseArgv')
    expect(start, 'parseArgv not found in cli/cookrew.mjs').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start) + 2)
    const parseArgv = new Function(`${body}; return parseArgv`)() as (
      argv: string[]
    ) => { cmd: string | null; args: string[]; flags: Record<string, string | boolean> }

    const parsed = parseArgv(['mobile', '--rotate'])
    expect(parsed.cmd).toBe('mobile')
    expect(parsed.args).toEqual([])
    expect(parsed.flags.rotate).toBe(true)
  })
})
