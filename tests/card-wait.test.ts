import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CARD_POLL_MS,
  CARD_SESSION_LIFE_MS,
  cardCheckStep,
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

  it('a refusal that is not about the payment stops the wait and is spoken in its own words', () => {
    const budget = cardPollStep({ ok: true, phase: { kind: 'denied', reason: 'budget', retryable: false } }, WAIT, alive, VARS)
    expect(budget).toEqual({
      kind: 'stopped',
      fault: { voice: 'apolog', title: denialCopy('budget', undefined, VARS).title, body: denialCopy('budget', undefined, VARS).body }
    })
    expect(cardPollStep({ ok: true, phase: { kind: 'gone' } }, WAIT, alive, VARS)).toEqual({
      kind: 'stopped',
      fault: { voice: 'apolog', title: MKT_GATE['mkt.gate.gone.title'], body: MKT_GATE['mkt.gate.gone.why'] }
    })
    expect(cardPollStep({ ok: true, phase: { kind: 'error', status: 500 } }, WAIT, alive, VARS)).toEqual({
      kind: 'stopped',
      fault: { voice: 'apolog', title: MKT_GATE['mkt.gate.error.title'], body: MKT_GATE['mkt.gate.error.why'] }
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

describe('the words', () => {
  it('ending the wait promises the same payment, never a new one; expiry says nothing was charged', () => {
    expect(MKT_PAY['mkt.pay.card.ended.body']).toMatch(/same payment/)
    expect(MKT_PAY['mkt.pay.card.ended.body']).toMatch(/never starts a new one/)
    expect(MKT_PAY['mkt.pay.card.expired.body']).toMatch(/nothing was charged/i)
    expect(MKT_PAY['mkt.pay.card.check']).toBe('CHECK AGAIN')
  })
})
