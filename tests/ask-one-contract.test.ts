import { describe, expect, it } from 'vitest'
import {
  DeliveryError,
  deliverAndConfirm,
  replyText,
  terminalDeliveryDeps,
  type DeliveryDeps
} from '../src/main/ask-delivery'
import { ASK_EXIT, ASK_HTTP_STATUS, ASK_REMEDY } from '../src/shared/ask-outcome'

// ONE CONTRACT, EVERY CALLER.
//
// For one release the CLI confirmed delivery and POST /api/terminal/:id/ask
// did not, so whether a dropped brief was reported depended on which client
// the owner used — and the phone is where they are least able to tell a
// dropped brief from a slow agent. These tests pin the shared order and the
// per-transport mapping, so a future transport cannot quietly opt out.

const PROMPT = 'Run the F2 simulation and report the counts.'

function observe(over: Partial<DeliveryDeps> = {}): DeliveryDeps & { submits: number } {
  const state = { submits: 0 }
  return {
    turnCountOf: () => 4,
    capture: () => 'idle\n> ',
    submit: () => {
      state.submits += 1
    },
    settle: async () => undefined,
    ...over,
    get submits() {
      return state.submits
    }
  } as DeliveryDeps & { submits: number }
}

const deliver =
  (reply = 'done') =>
  async (): Promise<string> =>
    reply

describe('deliverAndConfirm — the order lives in ONE place', () => {
  it('returns the reply when a turn actually ran', async () => {
    let turns = 4
    const result = await deliverAndConfirm({
      terminalId: 't1',
      agentName: 'Magpie',
      prompt: PROMPT,
      deliver: async () => {
        turns += 1
        return 'the answer'
      },
      observe: observe({ turnCountOf: () => turns })
    })
    expect(result).toMatchObject({ outcome: 'completed', reply: 'the answer' })
  })

  it('THROWS when the brief vanished — the owner’s case 2, three times in a row', async () => {
    // No paste, empty prompt, and the old code returned exit 0 for it. Three
    // consecutive drops to one agent is what made this the top requirement:
    // a command that cannot confirm delivery must fail loudly.
    const failing = deliverAndConfirm({
      terminalId: 't1',
      agentName: 'Magpie',
      prompt: PROMPT,
      deliver: deliver(''),
      observe: observe({ capture: () => 'an unrelated screen' })
    })
    await expect(failing).rejects.toBeInstanceOf(DeliveryError)
    await expect(failing).rejects.toThrow(/dropped/)
  })

  it('counts the turns BEFORE delivering, so a running turn is not miscredited', async () => {
    // If the count were read after delivery, an agent that happened to finish
    // an EARLIER turn during our wait would look like our brief succeeding.
    const reads: string[] = []
    await expect(
      deliverAndConfirm({
        terminalId: 't1',
        agentName: 'Magpie',
        prompt: PROMPT,
        deliver: async () => {
          reads.push('deliver')
          return ''
        },
        observe: observe({
          turnCountOf: () => {
            reads.push('count')
            return 4
          },
          capture: () => 'unrelated'
        })
      })
    ).rejects.toThrow()
    expect(reads[0]).toBe('count')
    expect(reads[1]).toBe('deliver')
  })

  it('carries the remedy in the error, so no caller has to hold the table', async () => {
    const failing = deliverAndConfirm({
      terminalId: 't1',
      agentName: 'Magpie',
      prompt: PROMPT,
      deliver: deliver(''),
      observe: observe({ capture: () => `> ${PROMPT}`, turnCountOf: () => 4 })
    })
    await expect(failing).rejects.toThrow(/do NOT resend/i)
  })
})

describe('the transports agree, and neither can opt out', () => {
  const failing = (): Promise<unknown> =>
    deliverAndConfirm({
      terminalId: 't1',
      agentName: 'Magpie',
      prompt: PROMPT,
      deliver: deliver(''),
      observe: observe({ capture: () => 'unrelated' })
    })

  it('the CLI exit code and the HTTP status come from ONE outcome', async () => {
    const error = (await failing().catch((e: unknown) => e)) as DeliveryError
    expect(error.outcome).toBe('dropped')
    expect(error.exitCode).toBe(ASK_EXIT.dropped)
    expect(ASK_HTTP_STATUS[error.outcome]).toBe(502)
  })

  it('never answers 200 for an outcome the CLI would call a failure', () => {
    for (const outcome of ['unsubmitted', 'dropped', 'busy', 'unreachable', 'unverifiable'] as const) {
      expect(ASK_HTTP_STATUS[outcome]).not.toBe(200)
      expect(ASK_EXIT[outcome]).not.toBe(0)
    }
  })

  it('shares a status between the two opposite remedies — so the BODY must carry them', () => {
    // 502 for both `unsubmitted` and `dropped` is safe ONLY because the body
    // names the outcome. A phone reading the status alone and guessing would
    // resend a brief into a box that already holds it.
    expect(ASK_HTTP_STATUS.unsubmitted).toBe(ASK_HTTP_STATUS.dropped)
    expect(ASK_REMEDY.unsubmitted).not.toBe(ASK_REMEDY.dropped)
  })

  it('does not spend "could not confirm" as success on EITHER transport', () => {
    expect(ASK_EXIT.unverifiable).not.toBe(0)
    expect(ASK_HTTP_STATUS.unverifiable).toBe(504)
  })
})

describe('replyText — an empty reply stops meaning four things', () => {
  it('says a turn ran when the diff saw nothing', () => {
    expect(replyText('', 0)).toMatch(/delivered/)
  })

  it('reports the resubmits it needed, so a swallowed CR is visible', () => {
    expect(replyText('', 2)).toMatch(/2 resubmit/)
  })

  it('passes a real reply through untouched', () => {
    expect(replyText('the answer', 1)).toBe('the answer')
  })
})

describe('terminalDeliveryDeps — the shared seam', () => {
  const turns = { list: () => [{ terminalId: 't1', turnCount: 7 }] }

  it('reads the turn count for a tracked terminal', () => {
    expect(terminalDeliveryDeps(turns, () => undefined).turnCountOf('t1')).toBe(7)
  })

  it('answers NULL for an untracked terminal — not zero', () => {
    // Zero would read as "no turns yet" and classify a detached agent's brief
    // as dropped. Null is "no view", which classifies as unverifiable.
    expect(terminalDeliveryDeps(turns, () => undefined).turnCountOf('ghost')).toBeNull()
  })

  it('submits a carriage return and nothing else', () => {
    const written: string[] = []
    terminalDeliveryDeps(turns, (data) => written.push(data)).submit('t1')
    expect(written).toEqual(['\r'])
  })
})
