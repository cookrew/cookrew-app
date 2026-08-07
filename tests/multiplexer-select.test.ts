import { describe, expect, it } from 'vitest'
import {
  NoHostMultiplexerError,
  selectMultiplexers
} from '../src/main/multiplexer-select'
import type { Multiplexer, MultiplexerCapabilities } from '../src/main/multiplexer'

function stub(
  id: string,
  available: boolean,
  caps: Partial<MultiplexerCapabilities> = {}
): Multiplexer {
  return {
    id,
    capabilities: { attach: true, copyModeSearch: true, monotonicHistory: true, ...caps },
    available: () => available
  } as unknown as Multiplexer
}

const tmux = (available = true): Multiplexer => stub('tmux', available)
const herdr = (available = true): Multiplexer =>
  stub('herdr', available, { attach: false, copyModeSearch: false })

describe('selectMultiplexers — the host invariant', () => {
  it('NEVER hosts on a backend that cannot attach, even if it is first', () => {
    // The whole point. A read-only backend listed first must not win the host
    // role — node-pty would consume its TUI stream and the scraper would
    // produce nonsense long after the mistake.
    const roles = selectMultiplexers({ candidates: [herdr(), tmux()] })
    expect(roles.host.id).toBe('tmux')
  })

  it('throws rather than guessing when nothing can host', () => {
    expect(() => selectMultiplexers({ candidates: [herdr()] })).toThrow(NoHostMultiplexerError)
    expect(() => selectMultiplexers({ candidates: [] })).toThrow(NoHostMultiplexerError)
  })

  it('names what it tried, so the failure is diagnosable', () => {
    try {
      selectMultiplexers({ candidates: [herdr(), tmux(false)] })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('herdr(available=true, attach=false)')
      expect((error as Error).message).toContain('tmux(available=false, attach=true)')
    }
  })

  it('skips an unavailable host and takes the next attach-capable one', () => {
    const other = stub('other-mux', true)
    expect(selectMultiplexers({ candidates: [tmux(false), other] }).host.id).toBe('other-mux')
  })
})

describe('selectMultiplexers — the reader role', () => {
  it('reads through the host by default — installing herdr changes nothing', () => {
    // Opt-in matters: a new backend on the read path changes what the Activity
    // Board shows, and that should be a decision, not a side effect of having
    // something installed.
    const roles = selectMultiplexers({ candidates: [tmux(), herdr()] })
    expect(roles.reader.id).toBe('tmux')
    expect(roles.readerReason).toContain('hosts and reads')
  })

  it('uses the accelerator for reads when explicitly enabled', () => {
    const roles = selectMultiplexers({
      candidates: [tmux(), herdr()],
      preferReadAccelerator: true
    })
    expect(roles.host.id).toBe('tmux')
    expect(roles.reader.id).toBe('herdr')
    expect(roles.readerReason).toContain('herdr reads')
  })

  it('falls back to the host when the accelerator is not available', () => {
    const roles = selectMultiplexers({
      candidates: [tmux(), herdr(false)],
      preferReadAccelerator: true
    })
    expect(roles.reader.id).toBe('tmux')
    expect(roles.readerReason).toContain('no read accelerator')
  })

  it('does not "accelerate" onto the host itself', () => {
    const roles = selectMultiplexers({ candidates: [tmux()], preferReadAccelerator: true })
    expect(roles.reader).toBe(roles.host)
  })
})
