import { describe, expect, it } from 'vitest'
import {
  claimReceiptDispatch,
  EMPTY_RECEIPT_LEDGER,
  MAX_REFUSAL_ROWS_PER_SCOPE,
  parseReceiptLedger,
  ReceiptAttemptSchema,
  ReceiptRecordSchema,
  reserveReceipt,
  type ReceiptAttempt,
} from '../src/shared/receipts'

const dispatchId = '00000000-0000-4000-8000-000000000042'

type DispatchReceiptAttempt = Extract<ReceiptAttempt, { dispatchId: string }>

const attempt = (
  over: Partial<DispatchReceiptAttempt> = {},
): DispatchReceiptAttempt => ({
  consumer: 'cust-42',
  idempotencyKey: 'order-7',
  quoteHash: 'sha256:quoted',
  verifiedQuoteHash: 'sha256:quoted',
  dispatchId,
  templateVersion: 'research@4',
  turnRange: { start: 12, end: 12 },
  channelId: 'channel-9',
  ...over,
})

describe('receipt state machine', () => {
  it('refuses a double charge and never issues a second reservation effect', () => {
    const first = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    const duplicate = reserveReceipt(first.ledger, attempt())

    expect(first.effect).toBe('reserve')
    expect(duplicate.effect).toBe('none')
    expect(duplicate.refusal).toBe('refused_double_charge')
    expect(duplicate.event?.state).toBe('refused_double_charge')
    expect(duplicate.ledger.map(({ state }) => state)).toEqual([
      'reserved',
      'refused_double_charge',
    ])
  })

  it('refuses double dispatch when the successful response was lost', () => {
    const reserved = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    const dispatched = claimReceiptDispatch(reserved.ledger, attempt())

    // The caller lost `dispatched` and retried the original paid request.
    const retry = reserveReceipt(dispatched.ledger, attempt())

    expect(dispatched.effect).toBe('dispatch')
    expect(retry.effect).toBe('none')
    expect(retry.refusal).toBe('refused_double_dispatch')
    expect(retry.receipt).toEqual(dispatched.receipt)
    expect(retry.event?.state).toBe('refused_double_dispatch')
  })

  it('refuses payment for any quote other than the quoted hash', () => {
    const mismatch = reserveReceipt(
      EMPTY_RECEIPT_LEDGER,
      attempt({ verifiedQuoteHash: 'sha256:different' }),
    )

    expect(mismatch.effect).toBe('none')
    expect(mismatch.receipt).toBeNull()
    expect(mismatch.refusal).toBe('refused_quote_mismatch')
    expect(mismatch.ledger).toHaveLength(1)
    expect(mismatch.event?.state).toBe('refused_quote_mismatch')
  })

  it('returns the existing receipt on idempotent re-entry', () => {
    const first = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    const retry = reserveReceipt(first.ledger, attempt())

    expect(first.ledger).toHaveLength(1)
    expect(retry.reentry).toBe(true)
    expect(retry.receipt).toEqual(first.receipt)
    expect(retry.receipt?.state).toBe('reserved')
    expect(retry.effect).toBe('none')
    expect(Object.isFrozen(retry.ledger)).toBe(true)
    expect(Object.isFrozen(retry.event)).toBe(true)
  })

  it('scopes an idempotency key to its consumer', () => {
    const first = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    const second = reserveReceipt(
      first.ledger,
      attempt({
        consumer: 'cust-99',
        dispatchId: '00000000-0000-4000-8000-000000000099',
      }),
    )
    const firstRetry = reserveReceipt(second.ledger, attempt())

    expect(second.effect).toBe('reserve')
    expect(second.refusal).toBeNull()
    expect(firstRetry.receipt?.consumer).toBe('cust-42')
    expect(firstRetry.receipt).toEqual(first.receipt)
  })

  it('still refuses a changed operation inside one consumer/key scope', () => {
    const first = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    const conflict = reserveReceipt(
      first.ledger,
      attempt({ dispatchId: '00000000-0000-4000-8000-000000000099' }),
    )

    expect(conflict.refusal).toBe('refused_idempotency_conflict')
    expect(conflict.receipt).toBeNull()
    expect(conflict.effect).toBe('none')
  })

  it('quarantines a torn JSONL row while preserving valid receipt bindings', () => {
    const reserved = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    const validRow = JSON.stringify(reserved.receipt)
    const parsed = parseReceiptLedger(`${validRow}\n{"consumer":"torn"\n`)

    expect(parsed.ledger).toHaveLength(1)
    expect(parsed.quarantined).toMatchObject([{ index: 1, reason: 'malformed_json' }])

    const retry = reserveReceipt(parsed.ledger, attempt())
    expect(retry.effect).toBe('none')
    expect(retry.refusal).toBe('refused_double_charge')
    expect(retry.receipt).toEqual(reserved.receipt)
  })

  it('quarantines schema-invalid rows and fails closed on the wrong container', () => {
    const parsed = parseReceiptLedger([{ consumer: 'missing-everything-else' }])

    expect(parsed.ledger).toEqual([])
    expect(parsed.quarantined).toMatchObject([{ index: 0, reason: 'invalid_record' }])
    expect(() => parseReceiptLedger({ rows: [] })).toThrow(/array or JSONL string/)
  })

  it('bounds refusal audit rows per consumer and idempotency key', () => {
    const reserved = reserveReceipt(EMPTY_RECEIPT_LEDGER, attempt())
    let ledger = reserved.ledger
    let last = reserveReceipt(ledger, attempt())
    ledger = last.ledger

    for (let index = 1; index < MAX_REFUSAL_ROWS_PER_SCOPE + 4; index += 1) {
      last = reserveReceipt(ledger, attempt())
      ledger = last.ledger
    }

    expect(ledger).toHaveLength(1 + MAX_REFUSAL_ROWS_PER_SCOPE)
    expect(last.refusal).toBe('refused_double_charge')
    expect(last.receipt).toEqual(reserved.receipt)
    expect(last.effect).toBe('none')
    expect(last.appended).toBe(false)
    expect(last.event).toBeNull()
  })

  it('requires exactly one dispatch or instance identity', () => {
    expect(
      ReceiptRecordSchema.safeParse({
        consumer: 'cust-42',
        idempotencyKey: 'instance-1',
        quoteHash: 'sha256:quoted',
        instanceId: 'inst-42',
        templateVersion: 'research@4',
        state: 'reserved',
      }).success,
    ).toBe(true)
    expect(ReceiptAttemptSchema.safeParse({ ...attempt(), instanceId: 'inst-42' }).success).toBe(
      false,
    )
  })
})
