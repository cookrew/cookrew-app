import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CARD_POLL_MS,
  CARD_SESSION_LIFE_MS,
  cardCheckStep,
  cardHeldFault,
  cardPollStep,
  type CardWait,
  type SettleAnswer
} from '../src/renderer/src/card-wait'
import { MKT_GATE, MKT_PAY, denialCopy } from '../src/shared/marketplace-copy'
import { CHECKOUT_MAX_LIFE_SECONDS } from '../src/shared/stripe-checkout'

/**
 * WAITING ON A CARD (M3).
 *
 * The sheet opens Stripe's page and asks the door, every few seconds, whether
 * that session has been paid. It used to stop asking after five minutes while
 * the page went on taking money for up to an hour, then fall silent with PAY
 * live again — and a second PAY across the door's idempotency window is a
 * second Checkout session, which is how a person is charged twice.
 *
 * The rule these pin: the wait lasts as long as the session can be paid; when
 * it ends it SAYS so and offers CHECK AGAIN, which asks about the SAME
 * session; and a fresh PAY exists only after the door has said that session
 * went unpaid past its life.
 */

const T0 = 1_700_000_000_000
const WAIT: CardWait = { session: 'cs_test_1', startedAt: T0 }
const VARS = { presetName: 'COOKREW Alpha', author: '@drej', handle: 'lin', owner: 'drej', team: 'alpha', price: '$1.00' }

const open: SettleAnswer = { ok: true, phase: { kind: 'open' } }
const unpaid: SettleAnswer = { ok: true, phase: { kind: 'denied', reason: 'payment_invalid', retryable: false } }
const uncheckable: SettleAnswer = { ok: true, phase: { kind: 'denied', reason: 'payment_unverifiable', retryable: true } }
const alive = T0 + CARD_SESSION_LIFE_MS - 1
const over = T0 + CARD_SESSION_LIFE_MS

describe('how long the sheet waits', () => {
  it('is the session’s whole life, from the constant the door itself uses — not a copy of the number', () => {
    expect(CARD_SESSION_LIFE_MS).toBe(CHECKOUT_MAX_LIFE_SECONDS * 1000)
    const source = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'card-wait.ts'), 'utf8')
    expect(source).not.toMatch(/30 \* 60|60 \* 60|1800|3600/)
    // And the old five-minute ceiling is gone from the sheet.
    const gate = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'ImportGate.tsx'), 'utf8')
    expect(gate).not.toContain('POLL_LIMIT')
    expect(CARD_POLL_MS).toBe(3000)
  })
})

describe('cardPollStep — one look at the door while waiting', () => {
  it('a paid session opens', () => {
    expect(cardPollStep(open, WAIT, alive, VARS)).toEqual({ kind: 'open' })
  })

  it('not paid yet, page still alive: keep waiting, and say nothing — that is the poll working', () => {
    expect(cardPollStep(unpaid, WAIT, T0 + 4_000, VARS)).toEqual({ kind: 'waiting', fault: null })
    expect(cardPollStep(unpaid, WAIT, alive, VARS)).toEqual({ kind: 'waiting', fault: null })
  })

  it('a door that cannot check right now is SAID, in the apology voice, and the wait goes on', () => {
    expect(cardPollStep(uncheckable, WAIT, alive, VARS)).toEqual({
      kind: 'waiting',
      fault: {
        voice: 'apolog',
        title: MKT_PAY['mkt.pay.error.unverifiable.title'],
        body: MKT_PAY['mkt.pay.error.unverifiable.body']
      }
    })
  })

  it('when the session’s life is over the wait ENDS, out loud — never a silent sheet with PAY live', () => {
    for (const answer of [unpaid, uncheckable]) {
      expect(cardPollStep(answer, WAIT, over, VARS)).toEqual({
        kind: 'ended',
        fault: {
          voice: 'apolog',
          title: MKT_PAY['mkt.pay.card.ended.title'],
          body: MKT_PAY['mkt.pay.card.ended.body']
        }
      })
    }
  })

  it('a refusal that is not about the payment stops the wait: its own headline, and an honest word about the card', () => {
    const honest = MKT_PAY['mkt.pay.card.unconfirmed.body']
    const budget = cardPollStep({ ok: true, phase: { kind: 'denied', reason: 'budget', retryable: false } }, WAIT, alive, VARS)
    expect(budget).toEqual({
      kind: 'stopped',
      fault: { voice: 'apolog', title: denialCopy('budget', undefined, VARS).title, body: honest }
    })
    expect(cardPollStep({ ok: true, phase: { kind: 'gone' } }, WAIT, alive, VARS)).toEqual({
      kind: 'stopped',
      fault: { voice: 'apolog', title: MKT_GATE['mkt.gate.gone.title'], body: honest }
    })
    expect(cardPollStep({ ok: true, phase: { kind: 'error', status: 500 } }, WAIT, alive, VARS)).toEqual({
      kind: 'stopped',
      fault: { voice: 'apolog', title: MKT_GATE['mkt.gate.error.title'], body: honest }
    })
    // Main holds no Bearer any more — the account changed, the app restarted.
    expect(cardPollStep({ ok: false, reason: 'not-signed-in' }, WAIT, alive, VARS)).toMatchObject({
      kind: 'stopped',
      fault: { voice: 'apolog', title: MKT_PAY['mkt.pay.error.unverifiable.title'] }
    })
    expect(cardPollStep({ ok: false, reason: 'refused', detail: 'the door hung up' }, WAIT, alive, VARS)).toMatchObject({
      kind: 'stopped',
      fault: { body: 'the door hung up' }
    })
  })

  it('a refusal whose sentence lacks its facts still says something, rather than throwing in a timer', () => {
    const step = cardPollStep({ ok: true, phase: { kind: 'denied', reason: 'version_gate', retryable: false } }, WAIT, alive, {})
    expect(step.kind).toBe('stopped')
  })

  it('a door quoting again instead of answering is not "paid": it stops, it does not open', () => {
    expect(cardPollStep({ ok: true, phase: { kind: 'pay', rails: [] } }, WAIT, alive, VARS).kind).toBe('stopped')
    expect(cardPollStep({ ok: true, phase: { kind: 'identify' } }, WAIT, alive, VARS).kind).toBe('stopped')
  })
})

describe('cardCheckStep — CHECK AGAIN, one press, the same session', () => {
  it('a payment that landed after the wait ended opens', () => {
    expect(cardCheckStep(open, WAIT, over + 60_000, VARS)).toEqual({ kind: 'open' })
  })

  it('the door says unpaid AND the session’s life is over: only now may a new payment be started', () => {
    expect(cardCheckStep(unpaid, WAIT, over, VARS)).toEqual({
      kind: 'expired',
      fault: {
        voice: 'apolog',
        title: MKT_PAY['mkt.pay.card.expired.title'],
        body: MKT_PAY['mkt.pay.card.expired.body']
      }
    })
  })

  it('unpaid while the page can still take money is NOT expired — the wait resumes, no new Checkout', () => {
    expect(cardCheckStep(unpaid, WAIT, alive, VARS)).toEqual({ kind: 'waiting', fault: null })
  })

  it('MAIN decides when a new payment is safe: while it still holds the session, nothing here frees PAY', () => {
    // Main remembers the session on disk and drops it only when the door says
    // unpaid after ITS clock says the session's life is over. A phone whose
    // clock runs fast must not conclude that by itself.
    const stillHeld: SettleAnswer = { ...unpaid, standing: true } as SettleAnswer
    expect(cardCheckStep(stillHeld, WAIT, over + 60_000, VARS)).toEqual({
      kind: 'ended',
      fault: { voice: 'apolog', title: MKT_PAY['mkt.pay.card.ended.title'], body: MKT_PAY['mkt.pay.card.ended.body'] }
    })
    expect(cardCheckStep(stillHeld, WAIT, alive, VARS)).toEqual({ kind: 'waiting', fault: null })
    // Main let go of it: expired, whatever this surface's own clock thinks.
    const letGo: SettleAnswer = { ...unpaid, standing: false } as SettleAnswer
    expect(cardCheckStep(letGo, WAIT, alive, VARS).kind).toBe('expired')
    expect(cardCheckStep(letGo, WAIT, over, VARS).kind).toBe('expired')
  })

  it('a door that still cannot check keeps CHECK AGAIN and says why — never a fresh PAY on a maybe', () => {
    for (const at of [alive, over]) {
      expect(cardCheckStep(uncheckable, WAIT, at, VARS)).toEqual({
        kind: 'stopped',
        fault: {
          voice: 'apolog',
          title: MKT_PAY['mkt.pay.error.unverifiable.title'],
          body: MKT_PAY['mkt.pay.error.unverifiable.body']
        }
      })
    }
  })

  it('any other refusal keeps CHECK AGAIN too', () => {
    expect(cardCheckStep({ ok: false, reason: 'not-signed-in' }, WAIT, over, VARS).kind).toBe('stopped')
    expect(cardCheckStep({ ok: true, phase: { kind: 'gone' } }, WAIT, over, VARS).kind).toBe('stopped')
  })
})

/**
 * ONCE A CARD PAGE EXISTS, NOBODY HERE KNOWS THE CARD WAS NOT CHARGED (F).
 *
 * The refusals a door gives were written for a person who has not paid: "this
 * team is out of sessions. Nothing was charged." Said during or after a card
 * wait, that sentence may be false — the card page was open the whole time.
 * And the door's "not paid" (`payment_invalid`) is one answer for several
 * facts: unpaid, yes, but also a session already used, or one whose amount or
 * buyer did not match what the door expected (stripe-rail.ts stripeSettle
 * returns the same `refused` for all of them). So no sentence spoken about a
 * card session claims nothing was charged, and each says what to do if it was.
 */
describe('no sentence about a card session claims nothing was charged (F)', () => {
  const honest = MKT_PAY['mkt.pay.card.unconfirmed.body']
  const REFUSALS: SettleAnswer[] = [
    ...['budget', 'workspace', 'payment_unavailable', 'not_answering', 'no_seat', 'scope', 'region', 'seat_limit', 'refunded', 'a-reason-nobody-shipped'].map(
      (reason): SettleAnswer => ({ ok: true, phase: { kind: 'denied', reason, retryable: false } })
    ),
    { ok: true, phase: { kind: 'gone' } },
    { ok: true, phase: { kind: 'error', status: 500 } },
    { ok: true, phase: { kind: 'error', status: 401 } },
    { ok: true, phase: { kind: 'identify' } },
    { ok: true, phase: { kind: 'pay', rails: [] } }
  ]
  const EVERYTHING: SettleAnswer[] = [
    ...REFUSALS,
    unpaid,
    uncheckable,
    { ...unpaid, standing: true } as SettleAnswer,
    { ...unpaid, standing: false } as SettleAnswer,
    { ok: false, reason: 'not-signed-in' },
    { ok: false, reason: 'refused' }
  ]

  it('says the door did not confirm the payment, and what to do if the card was charged', () => {
    expect(honest).toBe(
      'This door did not confirm the card payment. If your card was charged, press CHECK AGAIN; the payment is tied to your account at this door.'
    )
  })

  it.each(REFUSALS.map((answer) => [JSON.stringify(answer.ok ? answer.phase : answer), answer] as const))(
    'a refusal during or after the wait (%s) keeps its headline and says the honest thing under it',
    (_what, answer) => {
      for (const decide of [cardPollStep, cardCheckStep]) {
        for (const at of [alive, over]) {
          const step = decide(answer, WAIT, at, VARS)
          expect(step.kind).toBe('stopped')
          if (step.kind === 'stopped') {
            expect(step.fault.body).toBe(honest)
            expect(step.fault.title.length).toBeGreaterThan(0)
          }
        }
      }
    }
  )

  it('nothing either function can say claims the card was not charged, or that nothing happened', () => {
    for (const answer of EVERYTHING) {
      for (const decide of [cardPollStep, cardCheckStep]) {
        for (const at of [T0 + 1, alive, over, over + 3_600_000]) {
          const said = JSON.stringify(decide(answer, WAIT, at, VARS))
          expect(said, said).not.toMatch(/nothing was charged|nothing was installed|not charged|no charge|ended unpaid|went unpaid/i)
        }
      }
    }
  })

  it('when a new payment is freed, the sentence still does not say the first one took nothing', () => {
    const step = cardCheckStep({ ...unpaid, standing: false } as SettleAnswer, WAIT, over, VARS)
    expect(step.kind).toBe('expired')
    const body = MKT_PAY['mkt.pay.card.expired.body']
    expect(body).toMatch(/did not confirm a payment/)
    expect(body).toMatch(/If your card was charged/)
    expect(body).toMatch(/before paying again/)
    expect(MKT_PAY['mkt.pay.card.expired.title']).not.toMatch(/unpaid/i)
  })

  it('a sheet OPENED on a payment in flight that the door refuses says the same honest thing, not the refusal band', () => {
    expect(cardHeldFault({ kind: 'pay', rails: [] }, VARS)).toBeNull()
    expect(cardHeldFault({ kind: 'open' }, VARS)).toBeNull()
    const budget = cardHeldFault({ kind: 'denied', reason: 'budget', retryable: false }, VARS)
    expect(budget).toEqual({ voice: 'apolog', title: denialCopy('budget', undefined, VARS).title, body: honest })
    expect(cardHeldFault({ kind: 'gone' }, VARS)?.body).toBe(honest)
    // And the sheet stays on the pay step for it: the band that says "Nothing was charged" is never drawn over a card in flight.
    const gate = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'ImportGate.tsx'), 'utf8')
    expect(gate).toContain('cardHeldFault(result.phase, deniedVarsRef.current)')
    expect(gate).toMatch(/card !== null\s*\?\s*\{ kind: 'pay' \}/)
  })
})

describe('the words', () => {
  it('ending the wait promises the same payment, never a new one', () => {
    expect(MKT_PAY['mkt.pay.card.ended.body']).toMatch(/same payment/)
    expect(MKT_PAY['mkt.pay.card.ended.body']).toMatch(/never starts a new one/)
    expect(MKT_PAY['mkt.pay.card.check']).toBe('CHECK AGAIN')
  })
})
