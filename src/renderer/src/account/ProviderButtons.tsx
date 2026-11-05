import { useEffect, useRef, useState } from 'react'
import type { ProviderId, ProviderOffer } from '../../../shared/oauth'
import { cookrew } from '../api'
import { PROVIDER_COPY, continueLabel, tripGuard, waitingLabel } from './provider-store'

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

/** A guard that cancels this surface's trip when the surface goes. */
export function useTripGuard(): ReturnType<typeof tripGuard> {
  const guard = useRef(tripGuard(() => void cookrew().accountOAuthCancel?.())).current
  useEffect(() => () => guard.leave(), [guard])
  return guard
}

/**
 * THE SAME, FOR A SURFACE WHOSE ACT ONLY SOMETIMES GOES THROUGH A BROWSER.
 *
 * On a passwordless account a plain-looking button can open a provider's page,
 * and a person who closes the sheet must not find the act finished anyway. With
 * `on` false this watches nothing, so a password account sees no change.
 */
export function useWatchedTrip(on: boolean): {
  waiting: boolean
  watch: <T>(work: Promise<T>) => Promise<T>
  cancel: () => void
} {
  const guard = useTripGuard()
  const [live, setLive] = useState(0)
  const watch = <T,>(work: Promise<T>): Promise<T> => {
    if (!on) return work
    const from = guard.begin()
    setLive((count) => count + 1)
    return work.finally(() => {
      guard.end(from)
      setLive((count) => Math.max(0, count - 1))
    })
  }
  return { waiting: live > 0, watch, cancel: () => guard.leave() }
}

/** Where the person went, and the way out. */
export function TripWait({ shown, onCancel }: { shown: boolean; onCancel: () => void }): React.JSX.Element | null {
  if (!shown) return null
  return (
    <div className="cr-acct-providers" role="status">
      <p className="gs-hint">{PROVIDER_COPY.WAITING}</p>
      <button className="gs-ghost" onClick={onCancel}>
        CANCEL
      </button>
    </div>
  )
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
