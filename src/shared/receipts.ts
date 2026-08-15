import { z } from 'zod'

const boundedId = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`)

const ConsumerSchema = boundedId('consumer', 128)
const IdempotencyKeySchema = boundedId('idempotencyKey', 256)
const QuoteHashSchema = boundedId('quoteHash', 256)
const InstanceIdSchema = boundedId('instanceId', 256)
const TemplateVersionSchema = boundedId('templateVersion', 128)
const ChannelIdSchema = boundedId('channelId', 256)

export const TurnRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ start, end }) => end >= start, {
    message: 'turnRange.end must be greater than or equal to turnRange.start',
  })

export type TurnRange = z.infer<typeof TurnRangeSchema>

export const ReceiptStateSchema = z.enum([
  'reserved',
  'dispatched',
  'refused_quote_mismatch',
  'refused_idempotency_conflict',
  'refused_double_charge',
  'refused_double_dispatch',
  'refused_not_reserved',
])

export type ReceiptState = z.infer<typeof ReceiptStateSchema>
export type ReceiptRefusalState = Exclude<ReceiptState, 'reserved' | 'dispatched'>

const receiptFields = {
  consumer: ConsumerSchema,
  idempotencyKey: IdempotencyKeySchema,
  quoteHash: QuoteHashSchema,
  templateVersion: TemplateVersionSchema,
  turnRange: TurnRangeSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  state: ReceiptStateSchema,
}

const DispatchReceiptRecordSchema = z
  .object({
    ...receiptFields,
    dispatchId: z.string().uuid(),
    instanceId: z.never().optional(),
  })
  .strict()

const InstanceReceiptRecordSchema = z
  .object({
    ...receiptFields,
    dispatchId: z.never().optional(),
    instanceId: InstanceIdSchema,
  })
  .strict()

/** One immutable row in the append-only receipt ledger. */
export const ReceiptRecordSchema = z.union([
  DispatchReceiptRecordSchema,
  InstanceReceiptRecordSchema,
])

export type ReceiptRecord = z.infer<typeof ReceiptRecordSchema>
export type ReceiptLedger = readonly Readonly<ReceiptRecord>[]

export const MAX_REFUSAL_ROWS_PER_SCOPE = 8

export interface QuarantinedReceiptRow {
  /** Zero-based position in the input array or JSONL text. */
  readonly index: number
  readonly reason: 'malformed_json' | 'invalid_record'
  readonly issues: readonly string[]
}

export interface ReceiptLedgerParseResult {
  readonly ledger: ReceiptLedger
  readonly quarantined: readonly Readonly<QuarantinedReceiptRow>[]
}

const attemptFields = {
  consumer: ConsumerSchema,
  idempotencyKey: IdempotencyKeySchema,
  quoteHash: QuoteHashSchema,
  verifiedQuoteHash: QuoteHashSchema,
  templateVersion: TemplateVersionSchema,
  turnRange: TurnRangeSchema.optional(),
  channelId: ChannelIdSchema.optional(),
}

const DispatchReceiptAttemptSchema = z
  .object({
    ...attemptFields,
    dispatchId: z.string().uuid(),
    instanceId: z.never().optional(),
  })
  .strict()

const InstanceReceiptAttemptSchema = z
  .object({
    ...attemptFields,
    dispatchId: z.never().optional(),
    instanceId: InstanceIdSchema,
  })
  .strict()

/**
 * `quoteHash` is the server-side quote. `verifiedQuoteHash` is read from the
 * verified payment proof. Keeping both inputs makes pay-what-was-quoted an
 * unavoidable transition guard rather than a caller convention.
 */
export const ReceiptAttemptSchema = z.union([
  DispatchReceiptAttemptSchema,
  InstanceReceiptAttemptSchema,
])

export type ReceiptAttempt = z.infer<typeof ReceiptAttemptSchema>

export interface ReceiptTransition {
  readonly ledger: ReceiptLedger
  /** The accepted receipt to return to the caller, including on safe re-entry. */
  readonly receipt: Readonly<ReceiptRecord> | null
  /** Null once the refusal audit cap for this consumer/key has been reached. */
  readonly event: Readonly<ReceiptRecord> | null
  readonly appended: boolean
  /** Only the winner of a reservation/dispatch claim receives a side effect. */
  readonly effect: 'reserve' | 'dispatch' | 'none'
  readonly refusal: ReceiptRefusalState | null
  readonly reentry: boolean
  /** Invalid persisted rows ignored under the quarantine policy. */
  readonly quarantined: readonly Readonly<QuarantinedReceiptRow>[]
}

export const EMPTY_RECEIPT_LEDGER: ReceiptLedger = Object.freeze([])

function freezeRecord(record: ReceiptRecord): Readonly<ReceiptRecord> {
  if (record.turnRange) Object.freeze(record.turnRange)
  return Object.freeze(record)
}

function quarantine(
  index: number,
  reason: QuarantinedReceiptRow['reason'],
  issues: string[],
): Readonly<QuarantinedReceiptRow> {
  return Object.freeze({ index, reason, issues: Object.freeze(issues) })
}

/**
 * Parse persisted rows with an explicit quarantine policy.
 *
 * An invalid row is ignored and reported instead of taking every paid request
 * offline. It cannot authorize a reserve or dispatch: effects are permitted
 * only after a complete, schema-valid row is durably appended. A wrong outer
 * container still throws, because treating the wrong file/format as an empty
 * ledger would forget every accepted receipt and could double-charge.
 */
export function parseReceiptLedger(input: unknown): ReceiptLedgerParseResult {
  if (!Array.isArray(input) && typeof input !== 'string') {
    throw new TypeError('receipt ledger must be an array or JSONL string')
  }

  const ledger: Readonly<ReceiptRecord>[] = []
  const quarantined: Readonly<QuarantinedReceiptRow>[] = []
  const rows = Array.isArray(input) ? input : input.split('\n')

  rows.forEach((candidate, index) => {
    let value = candidate
    if (typeof input === 'string') {
      if (typeof candidate !== 'string' || candidate.trim().length === 0) return
      try {
        value = JSON.parse(candidate) as unknown
      } catch (error) {
        quarantined.push(
          quarantine(index, 'malformed_json', [
            error instanceof Error ? error.message : 'invalid JSON',
          ]),
        )
        return
      }
    }

    const parsed = ReceiptRecordSchema.safeParse(value)
    if (parsed.success) {
      ledger.push(freezeRecord(parsed.data))
      return
    }
    quarantined.push(
      quarantine(
        index,
        'invalid_record',
        parsed.error.issues.map(({ message }) => message),
      ),
    )
  })

  return Object.freeze({
    ledger: Object.freeze(ledger),
    quarantined: Object.freeze(quarantined),
  })
}

function acceptedReceiptFor(
  ledger: ReceiptLedger,
  consumer: string,
  idempotencyKey: string,
): Readonly<ReceiptRecord> | null {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const row = ledger[index]
    if (
      row.consumer === consumer &&
      row.idempotencyKey === idempotencyKey &&
      (row.state === 'reserved' || row.state === 'dispatched')
    ) {
      return row
    }
  }
  return null
}

function refusalCountFor(ledger: ReceiptLedger, consumer: string, idempotencyKey: string): number {
  return ledger.reduce(
    (count, row) =>
      row.consumer === consumer &&
      row.idempotencyKey === idempotencyKey &&
      row.state.startsWith('refused_')
        ? count + 1
        : count,
    0,
  )
}

function sameTurnRange(a: TurnRange | undefined, b: TurnRange | undefined): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && a.start === b.start && a.end === b.end
}

function sameTarget(receipt: ReceiptRecord, attempt: ReceiptAttempt): boolean {
  return 'dispatchId' in receipt
    ? 'dispatchId' in attempt && receipt.dispatchId === attempt.dispatchId
    : 'instanceId' in attempt && receipt.instanceId === attempt.instanceId
}

function sameBinding(receipt: ReceiptRecord, attempt: ReceiptAttempt): boolean {
  return (
    receipt.consumer === attempt.consumer &&
    receipt.quoteHash === attempt.quoteHash &&
    receipt.templateVersion === attempt.templateVersion &&
    receipt.channelId === attempt.channelId &&
    sameTurnRange(receipt.turnRange, attempt.turnRange) &&
    sameTarget(receipt, attempt)
  )
}

function rowFrom(attempt: ReceiptAttempt, state: ReceiptState): Readonly<ReceiptRecord> {
  const { verifiedQuoteHash: _verifiedQuoteHash, ...record } = attempt
  return freezeRecord(ReceiptRecordSchema.parse({ ...record, state }))
}

function appendTransition(
  ledger: ReceiptLedger,
  event: Readonly<ReceiptRecord>,
  receipt: Readonly<ReceiptRecord> | null,
  effect: ReceiptTransition['effect'],
  refusal: ReceiptRefusalState | null,
  quarantined: readonly Readonly<QuarantinedReceiptRow>[],
  reentry = false,
): ReceiptTransition {
  return Object.freeze({
    ledger: Object.freeze([...ledger, event]),
    receipt,
    event,
    appended: true,
    effect,
    refusal,
    reentry,
    quarantined,
  })
}

function cappedRefusal(
  ledger: ReceiptLedger,
  receipt: Readonly<ReceiptRecord> | null,
  refusal: ReceiptRefusalState,
  quarantined: readonly Readonly<QuarantinedReceiptRow>[],
  reentry: boolean,
): ReceiptTransition {
  return Object.freeze({
    ledger,
    receipt,
    event: null,
    appended: false,
    effect: 'none',
    refusal,
    reentry,
    quarantined,
  })
}

function refuse(
  ledger: ReceiptLedger,
  attempt: ReceiptAttempt,
  state: ReceiptRefusalState,
  quarantined: readonly Readonly<QuarantinedReceiptRow>[],
  receipt: Readonly<ReceiptRecord> | null = null,
  reentry = false,
): ReceiptTransition {
  if (
    refusalCountFor(ledger, attempt.consumer, attempt.idempotencyKey) >=
    MAX_REFUSAL_ROWS_PER_SCOPE
  ) {
    return cappedRefusal(ledger, receipt, state, quarantined, reentry)
  }
  const event = rowFrom(attempt, state)
  return appendTransition(ledger, event, receipt, 'none', state, quarantined, reentry)
}

function validatedInputs(
  inputLedger: ReceiptLedger,
  inputAttempt: ReceiptAttempt,
): {
  ledger: ReceiptLedger
  attempt: ReceiptAttempt
  quarantined: readonly Readonly<QuarantinedReceiptRow>[]
} {
  const parsed = parseReceiptLedger(inputLedger)
  return {
    ledger: parsed.ledger,
    attempt: ReceiptAttemptSchema.parse(inputAttempt),
    quarantined: parsed.quarantined,
  }
}

/**
 * Verify the payment's quote binding and claim its charge reservation.
 * Persist the returned ledger before honoring `effect: 'reserve'`.
 */
export function reserveReceipt(
  inputLedger: ReceiptLedger,
  inputAttempt: ReceiptAttempt,
): ReceiptTransition {
  const { ledger, attempt, quarantined } = validatedInputs(inputLedger, inputAttempt)
  const existing = acceptedReceiptFor(ledger, attempt.consumer, attempt.idempotencyKey)

  if (attempt.quoteHash !== attempt.verifiedQuoteHash) {
    return refuse(ledger, attempt, 'refused_quote_mismatch', quarantined)
  }
  if (existing && !sameBinding(existing, attempt)) {
    return refuse(ledger, attempt, 'refused_idempotency_conflict', quarantined)
  }
  if (existing?.state === 'dispatched') {
    return refuse(ledger, attempt, 'refused_double_dispatch', quarantined, existing, true)
  }
  if (existing?.state === 'reserved') {
    return refuse(ledger, attempt, 'refused_double_charge', quarantined, existing, true)
  }

  const receipt = rowFrom(attempt, 'reserved')
  return appendTransition(ledger, receipt, receipt, 'reserve', null, quarantined)
}

/**
 * Atomically claim dispatch for a reserved receipt. The first caller gets the
 * dispatch effect; retries get the existing receipt and can never dispatch it
 * again. Persist the returned ledger before performing the external dispatch.
 */
export function claimReceiptDispatch(
  inputLedger: ReceiptLedger,
  inputAttempt: ReceiptAttempt,
): ReceiptTransition {
  const { ledger, attempt, quarantined } = validatedInputs(inputLedger, inputAttempt)
  const existing = acceptedReceiptFor(ledger, attempt.consumer, attempt.idempotencyKey)

  if (attempt.quoteHash !== attempt.verifiedQuoteHash) {
    return refuse(ledger, attempt, 'refused_quote_mismatch', quarantined)
  }
  if (!existing) {
    return refuse(ledger, attempt, 'refused_not_reserved', quarantined)
  }
  if (!sameBinding(existing, attempt)) {
    return refuse(ledger, attempt, 'refused_idempotency_conflict', quarantined)
  }
  if (existing.state === 'dispatched') {
    return refuse(ledger, attempt, 'refused_double_dispatch', quarantined, existing, true)
  }

  const receipt = rowFrom(attempt, 'dispatched')
  return appendTransition(ledger, receipt, receipt, 'dispatch', null, quarantined)
}
