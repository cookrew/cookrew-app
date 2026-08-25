import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  promptArgs,
  promptViaHerdr,
  runCli,
  submitArgs,
  submitViaHerdr,
  waitArgs,
  waitForAgentState
} from '../src/main/herdr-agent-wait'

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

describe('promptArgs — agent-to-agent ask as a herdr primitive', () => {
  it('submits and waits in ONE herdr call, prompt as a single argv element', () => {
    const args = promptArgs('w1:p3', 'fix the bug\nwith details', 60_000)
    expect(args.slice(0, 4)).toEqual(['agent', 'prompt', 'w1:p3', 'fix the bug\nwith details'])
    expect(args).toContain('--wait')
    expect(args).toContain('--timeout')
  })

  it('treats blocked as an answer — a permission prompt must not eat the timeout', () => {
    expect(promptArgs('t', 'p', 1000)).toContain('blocked')
  })
})

describe('promptViaHerdr — the tri-state IS the safety contract', () => {
  const opts = { session: 'cookrew', configPath: '/c', target: 'w1:p3', timeoutMs: 1000, prompt: 'hi' }

  it('done: herdr submitted and the agent finished', async () => {
    expect(await promptViaHerdr({ ...opts, exec: async () => {} })).toBe('done')
  })

  it('failed: never delivered — typing is the correct fallback', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('agent_not_found')
    }
    expect(await promptViaHerdr({ ...opts, exec: failing })).toBe('failed')
  })

  it('SUBMITTED on a stall — the prompt landed, retyping double-submits', async () => {
    // Measured live: herdr typed the prompt, its detector saw no state
    // change, the CLI errored agent_prompt_stalled — and the boolean version
    // of this function read that as "failed", typed the prompt AGAIN, and a
    // duplicate sat queued in the agent's input box.
    const stalled = async (): Promise<void> => {
      const error = new Error('command failed') as Error & { stdout: string }
      error.stdout = '{"error":{"code":"agent_prompt_stalled","message":"no observed state change"}}'
      throw error
    }
    expect(await promptViaHerdr({ ...opts, exec: stalled })).toBe('submitted')
  })

  it('scopes to COOKREW session', async () => {
    let env: NodeJS.ProcessEnv = {}
    await promptViaHerdr({ ...opts, exec: async (_f, _a, e) => { env = e } })
    expect(env.HERDR_SESSION).toBe('cookrew')
  })

  it('threads the AbortSignal down to the exec seam (Sol r8 P1)', async () => {
    // execFile's own `signal` option is the kill switch: a retired terminal
    // or interrupted dispatch fires it and the CLI child dies NOW instead of
    // at the ten-minute timeout. The seam must actually receive it.
    const abort = new AbortController()
    let observed: AbortSignal | undefined
    await promptViaHerdr({
      ...opts,
      signal: abort.signal,
      exec: async (_f, _a, _e, signal) => {
        observed = signal
      }
    })
    expect(observed).toBe(abort.signal)
  })

  it('an aborted child settles as failed — the canceller owns what happens next', async () => {
    // The generation/liveness checks at every caller make a late 'failed'
    // from a killed child change no state; what matters here is that the
    // rejection SETTLES the promise instead of hanging it.
    const aborted = async (): Promise<void> => {
      const error = new Error('The operation was aborted') as Error & { code: string }
      error.code = 'ABORT_ERR'
      throw error
    }
    expect(await promptViaHerdr({ ...opts, exec: aborted })).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Sol r8 P1 — the submission-ack mode. Investigated against the real CLI:
// `herdr agent prompt <target> <text>` WITHOUT `--wait` returns as soon as
// herdr has typed the prompt, which is exactly the bytes-in-flight window the
// producer lease guards — the reply-wait can run outside the lease.
// ---------------------------------------------------------------------------

describe('submitArgs — submission acknowledgement, not turn completion', () => {
  it('omits --wait and --until: the call returns at submission', () => {
    const args = submitArgs('w1:p3', 'fix the bug')
    expect(args.slice(0, 4)).toEqual(['agent', 'prompt', 'w1:p3', 'fix the bug'])
    expect(args).not.toContain('--wait')
    expect(args).not.toContain('--until')
  })

  it('carries NO --timeout — the CLI rejects it without --wait (measured live)', () => {
    // The first real ack-mode dispatch delivered NOTHING while reporting
    // 'submitted': `herdr agent prompt <t> <p> --timeout N` errors with
    // "--timeout requires --wait", and the loose timeout regex classified
    // that usage error as a timeout. Ack-mode submission is bounded by the
    // caller's AbortSignal, never by a CLI flag the CLI refuses.
    expect(submitArgs('w1:p1', 'hello')).toEqual(['agent', 'prompt', 'w1:p1', 'hello'])
  })

  it('a usage error is FAILED, never submitted (the silent-non-delivery bug)', async () => {
    const outcome = await submitViaHerdr({
      session: 's',
      configPath: '/tmp/c',
      target: 'w1:p1',
      timeoutMs: 5000,
      prompt: 'hello',
      exec: async () => {
        throw new Error('--timeout requires --wait')
      }
    })
    expect(outcome).toBe('failed')
  })
})

describe('submitViaHerdr — the two-state ack contract', () => {
  const opts = { session: 'cookrew', configPath: '/c', target: 'w1:p3', timeoutMs: 1000, prompt: 'hi' }

  it('submitted: herdr accepted the prompt', async () => {
    expect(await submitViaHerdr({ ...opts, exec: async () => {} })).toBe('submitted')
  })

  it('failed: herdr positively refused — typing is the correct fallback', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('agent_not_found')
    }
    expect(await submitViaHerdr({ ...opts, exec: failing })).toBe('failed')
  })

  it('AMBIGUOUS outcomes are submitted, never failed — the do-not-retype rule', async () => {
    // A killed child or expired wait leaves the prompt possibly in the pane;
    // reporting 'failed' invites the caller to type a duplicate on top.
    const timedOut = async (): Promise<void> => {
      const error = new Error('killed') as Error & { code: string }
      error.code = 'ETIMEDOUT'
      throw error
    }
    expect(await submitViaHerdr({ ...opts, exec: timedOut })).toBe('submitted')
  })

  it('scopes to COOKREW session and threads the signal', async () => {
    const abort = new AbortController()
    let env: NodeJS.ProcessEnv = {}
    let observed: AbortSignal | undefined
    await submitViaHerdr({
      ...opts,
      signal: abort.signal,
      exec: async (_f, _a, e, signal) => {
        env = e
        observed = signal
      }
    })
    expect(env.HERDR_SESSION).toBe('cookrew')
    expect(observed).toBe(abort.signal)
  })
})

// ---------------------------------------------------------------------------
// Sol r9 P1-5 — the bounded TERM→KILL escalation. execFile's own `signal`
// option sends exactly one SIGTERM and hopes; a wedged or TERM-trapping herdr
// child kept its process and pipes alive for the full caller timeout. runCli
// now owns the ChildProcess: SIGTERM on abort, a bounded wait, then SIGKILL —
// settled exactly once, from the child's real exit.
// ---------------------------------------------------------------------------

// Windows: POSIX signals SIGTERM/SIGKILL do not exist — macOS/Linux CI covers it.
describe.skipIf(process.platform === 'win32')('runCli — abort escalates SIGTERM to SIGKILL (Sol r9 P1-5)', () => {
  it('a child that TRAPS SIGTERM is SIGKILLed after the bound, and the promise settles', async () => {
    const abort = new AbortController()
    // A real child that ignores the courtesy: traps SIGTERM and spins.
    const promise = runCli(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      process.env,
      abort.signal,
      // The escalation bound, shrunk for the test; production keeps 2s.
      200
    )
    // Give the child time to boot and install its trap, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 700))
    abort.abort()
    // The promise settles — from the child's actual exit, which only the
    // SIGKILL escalation can produce — instead of hanging on the trap.
    const outcome = await promise.then(
      () => ({ rejected: false as const }),
      (error: NodeJS.ErrnoException & { signal?: string }) => ({
        rejected: true as const,
        signal: error.signal
      })
    )
    expect(outcome.rejected).toBe(true)
    expect(outcome.rejected && outcome.signal).toBe('SIGKILL')
  }, 15_000)

  it('a cooperative child exits on the SIGTERM alone — no escalation needed', async () => {
    const abort = new AbortController()
    const promise = runCli(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.env,
      abort.signal,
      5000
    )
    await new Promise((resolve) => setTimeout(resolve, 700))
    abort.abort()
    const outcome = await promise.then(
      () => ({ rejected: false as const }),
      (error: NodeJS.ErrnoException & { signal?: string }) => ({
        rejected: true as const,
        signal: error.signal
      })
    )
    expect(outcome.rejected).toBe(true)
    expect(outcome.rejected && outcome.signal).toBe('SIGTERM')
  }, 15_000)

  it('a signal already aborted at call time REFUSES WITHOUT SPAWNING (Sol r11 P0-4)', async () => {
    // The r9 shape spawned first and killed second — a race the child could
    // win: herdr could type the prompt in the beat between exec and SIGTERM.
    // A refusal cannot lose that race, and the marker file is the proof: a
    // child that ran, however briefly, would have written it.
    const abort = new AbortController()
    abort.abort()
    const marker = path.join(tmpdir(), `cookrew-preabort-${process.pid}-${Date.now()}`)
    const promise = runCli(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      process.env,
      abort.signal,
      200
    )
    await expect(promise).rejects.toThrow(/aborted before spawn/)
    // Give a wrongly-spawned child every chance to leave its evidence.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(existsSync(marker)).toBe(false)
  }, 15_000)
})
