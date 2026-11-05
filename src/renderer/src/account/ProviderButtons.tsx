import { useEffect, useState } from 'react'
import type { ProviderId, ProviderOffer } from '../../../shared/oauth'
import { cookrew } from '../api'
import { PROVIDER_COPY, continueLabel, waitingLabel } from './provider-store'

/**
 * WHAT THE REGISTRY OFFERS, READ ONCE.
 *
 * It starts empty and it stays empty on a registry with no client id and
 * secret, on an older registry, and with no network. All three are the same
 * thing here: no button, and the sheet exactly as it always was.
 */
export function useProviders(): readonly ProviderOffer[] {
  const [offers, setOffers] = useState<readonly ProviderOffer[]>([])
  useEffect(() => {
    let live = true
    void cookrew()
      .accountOAuthProviders?.()
      .then((listed) => {
        if (live) setOffers(listed)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return offers
}

/** The buttons, or the wait they turn into. Nothing at all when none is offered. */
export function ProviderButtons({
  offers,
  waiting,
  onStart,
  onCancel,
}: {
  offers: readonly ProviderOffer[]
  /** The provider whose browser trip is in flight. */
  waiting: ProviderId | null
  onStart: (provider: ProviderId) => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (offers.length === 0) return null
  if (waiting !== null) {
    return (
      <div className="cr-acct-providers" role="status">
        <p className="gs-consequence">{waitingLabel(waiting)}</p>
        <p className="gs-hint">{PROVIDER_COPY.WAITING}</p>
        <button className="gs-ghost" onClick={onCancel}>
          CANCEL
        </button>
      </div>
    )
  }
  return (
    <div className="cr-acct-providers">
      {offers.map((offer) => (
        <button key={offer.id} className="gs-ghost cr-acct-provider" onClick={() => onStart(offer.id)}>
          {continueLabel(offer)}
        </button>
      ))}
    </div>
  )
}
