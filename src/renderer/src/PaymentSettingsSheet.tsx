import { useRef, useState } from 'react'
import { MKT_SERVE, fillCopy } from '../../shared/marketplace-copy'
import {
  isPayToAddress,
  stripeSecretMode,
  type PaymentConfigReason,
  type ServedPaymentStatus
} from '../../shared/served-payment-config'
import { cookrew } from './api'
import './grant-surface.css'

function reasonCopy(reason: PaymentConfigReason): string {
  if (reason === 'invalid-pay-to') return MKT_SERVE['mkt.serve.payment.invalid-pay-to']
  if (reason === 'invalid-stripe-key') {
    return MKT_SERVE['mkt.serve.payment.invalid-stripe-key']
  }
  return MKT_SERVE['mkt.serve.payment.write-failed']
}

export function PaymentSettingsSheet({
  status,
  onStatus,
  onClose
}: {
  status: ServedPaymentStatus
  onStatus: (status: ServedPaymentStatus) => void
  onClose: () => void
}): React.JSX.Element {
  const [payTo, setPayTo] = useState(status.x402.ready ? status.x402.payTo : '')
  const stripeInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'x402' | 'stripe' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const savePayTo = (): void => {
    if (busy !== null) return
    if (!isPayToAddress(payTo)) {
      setError(MKT_SERVE['mkt.serve.payment.invalid-pay-to'])
      return
    }
    setBusy('x402')
    setError(null)
    void cookrew()
      .servingSetPayTo(payTo.trim())
      .then((result) => {
        if (result.ok) {
          if (result.status.x402.ready) setPayTo(result.status.x402.payTo)
          onStatus(result.status)
        }
        else setError(reasonCopy(result.reason))
      })
      .catch(() => setError(MKT_SERVE['mkt.serve.payment.write-failed']))
      .finally(() => setBusy(null))
  }

  const saveStripe = (): void => {
    if (busy !== null) return
    const field = stripeInput.current
    if (!field) return
    if (stripeSecretMode(field.value) === null) {
      setError(MKT_SERVE['mkt.serve.payment.invalid-stripe-key'])
      return
    }

    // Invoke first, then erase synchronously. The secret never enters React
    // state and is gone from the DOM before the main process replies.
    const write = cookrew().servingSetStripeSecret(field.value)
    field.value = ''
    setBusy('stripe')
    setError(null)
    void write
      .then((result) => {
        if (result.ok) onStatus(result.status)
        else setError(reasonCopy(result.reason))
      })
      .catch(() => setError(MKT_SERVE['mkt.serve.payment.write-failed']))
      .finally(() => setBusy(null))
  }

  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label={MKT_SERVE['mkt.serve.payment.title']}>
      <div
        className="gs-sheet gs-small payment-sheet cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>{MKT_SERVE['mkt.serve.payment.title']}</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <p className="gs-sub">{MKT_SERVE['mkt.serve.payment.subtitle']}</p>

        <section className="payment-rail-section">
          <h3>{MKT_SERVE['mkt.serve.payment.usdc.title']}</h3>
          {status.x402.ready && (
            <p className="payment-ready">{MKT_SERVE['mkt.serve.payment.usdc.ready']}</p>
          )}
          <label className="gs-label" htmlFor="payment-pay-to">
            {MKT_SERVE['mkt.serve.payment.usdc.label']}
          </label>
          <input
            id="payment-pay-to"
            className="gs-input gs-key"
            value={payTo}
            autoComplete="off"
            spellCheck={false}
            placeholder="0x receiving address"
            onChange={(event) => setPayTo(event.target.value)}
          />
          <p className="gs-hint">{MKT_SERVE['mkt.serve.payment.usdc.hint']}</p>
          <button className="gs-primary payment-save" disabled={busy !== null} onClick={savePayTo}>
            {busy === 'x402' ? 'SAVING…' : MKT_SERVE['mkt.serve.payment.usdc.save']}
          </button>
        </section>

        <section className="payment-rail-section">
          <h3>{MKT_SERVE['mkt.serve.payment.stripe.title']}</h3>
          {status.stripe.ready ? (
            <p className="payment-ready">
              {fillCopy(MKT_SERVE['mkt.serve.payment.stripe.ready'], { mode: status.stripe.mode })}
            </p>
          ) : (
            <>
              <label className="gs-label" htmlFor="payment-stripe-key">
                {MKT_SERVE['mkt.serve.payment.stripe.label']}
              </label>
              <input
                id="payment-stripe-key"
                ref={stripeInput}
                className="gs-input gs-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste secret key"
              />
              <p className="gs-hint">{MKT_SERVE['mkt.serve.payment.stripe.hint']}</p>
              <button className="gs-primary payment-save" disabled={busy !== null} onClick={saveStripe}>
                {busy === 'stripe' ? 'SAVING…' : MKT_SERVE['mkt.serve.payment.stripe.save']}
              </button>
            </>
          )}
        </section>

        {error && <p className="gs-paste-error gs-loud" role="alert">{error}</p>}
        <footer className="gs-sheet-foot">
          <button className="gs-primary" onClick={onClose}>DONE</button>
        </footer>
      </div>
    </div>
  )
}
