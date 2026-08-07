import { describe, expect, it } from 'vitest'
import { waitArgs, waitForAgentState } from '../src/main/herdr-agent-wait'

/**
 * This replaces `cookrew ask`'s output-quiescence heuristic, which is wrong in
 * both directions: a mid-turn pause reads as finished, and a fast reply still
 * costs the full silence window. The tests that matter are the ones about
 * FAILING SOFTLY, because a hard failure here would turn a degraded signal
 * into a broken `cookrew ask`.
 */

describe('waitArgs', () => {
  it('repeats --until per state, which is how herdr takes a list', () => {
    expect(waitArgs('w1:p3', ['idle', 'done'], 5000)).toEqual([
      'agent',
      'wait',
      'w1:p3',
      '--until',
      'idle',
      '--until',
      'done',
      '--timeout',
      '5000'
    ])
  })

  it('always passes a timeout — herdr waits FOREVER without one', () => {
    // Documented behaviour: "Without --timeout, waits indefinitely." An ask
    // that never returns would hang the caller with no way out.
    expect(waitArgs('w1:p1', ['idle'], 60_000)).toContain('--timeout')
  })
})

describe('waitForAgentState', () => {
  const opts = { session: 'cookrew', configPath: '/c', target: 'w1:p1', timeoutMs: 1000 }

  it('is true when herdr reports the state', async () => {
    expect(await waitForAgentState({ ...opts, exec: async () => {} })).toBe(true)
  })

  it('is FALSE, not a throw, when herdr times out or is unreachable', async () => {
    // The caller falls back to the quiescence heuristic on false. Throwing
    // would propagate out of `cookrew ask` and fail a request that the old
    // code path would have answered.
    const failing = async (): Promise<void> => {
      throw new Error('timed out waiting for agent')
    }
    expect(await waitForAgentState({ ...opts, exec: failing })).toBe(false)
  })

  it('defaults to the states that mean "not working any more"', async () => {
    let seen: string[] = []
    await waitForAgentState({
      ...opts,
      exec: async (_file, args) => {
        seen = args
      }
    })
    // blocked counts: an agent waiting on a permission prompt has stopped
    // producing output and is exactly what the caller needs to hear about.
    expect(seen).toContain('idle')
    expect(seen).toContain('done')
    expect(seen).toContain('blocked')
  })

  it('scopes the call to COOKREW session, never the user\'s herdr', async () => {
    let env: NodeJS.ProcessEnv = {}
    await waitForAgentState({
      ...opts,
      exec: async (_file, _args, passed) => {
        env = passed
      }
    })
    expect(env.HERDR_SESSION).toBe('cookrew')
  })
})
