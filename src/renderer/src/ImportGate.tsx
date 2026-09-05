import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew, type ServeFacePreview, type ServePhase, type ServeRail } from './api'
import { GateSheet, type PayFault, type WalletChoice } from './GateSheet'
import type { GatePhase } from '../../shared/gate-walk'
import { MKT_PAY, fillCopy } from '../../shared/marketplace-copy'

/**
 * THE PAID IMPORT, through the one Gate Sheet.
 *
 * A served team that charges is met the same way every other gated thing in
 * Cookrew is met: identify → pay → open, painted by `gateWalk`. This component
 * is the ceremony the sheet deliberately does not host — it asks the door what
 * it wants, offers the rails the door actually advertises, carries out the
 * payment on the chosen one, and re-renders the sheet with what came back.
 *
 * WHICH DOOR. The walk is the INSTALL door, not the call door. R5 says a call
 * never takes money inline, and it does not: the 402 fires at session START,
 * which is this moment — acquiring the session — and never again inside the
 * conversation that follows. The card placed at the end opens its line into a
 * session already paid for, which is why it never meets money.
 *
 * WHERE THE MONEY IS HANDLED. Not here. The renderer names a door and a rail;
 * the main process holds the Bearer, signs the transfer authorization with the
 * wallet this device provisioned, and talks to Stripe. A key never crosses IPC.
 */

const POLL_MS = 3000
const POLL_LIMIT = 100 // ~5 minutes, the life of a Checkout session

/** mm:ss until a quote expires, or null when it carries no clock. */
function remaining(expiry: number, now: number): string | null {
  if (!Number.isFinite(expiry) || expiry <= 0) return null
  const left = Math.max(0, Math.floor((expiry - now) / 1000))
  const mm = Math.floor(left / 60)
  const ss = String(left % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

const shortAddress = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`

export function ImportGate({
  link,
  face,
  onOpen,
  onDismiss
}: {
  link: string
  face: ServeFacePreview
  /**
   * The door admitted us: place the card, carrying what was actually paid so
   * the card can state it and the close prompt can quote it. Undefined when
   * the door let us in without charging (an already-open session).
   */
  onOpen: (paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<ServePhase | null>(null)
  const [wallet, setWallet] = useState<{ address: string } | null>(null)
  const [railId, setRailId] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [fault, setFault] = useState<PayFault | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** The rail and terms a payment actually settled on, or null if none did. */
  const [settledOn, setSettledOn] = useState<{
    price: string
    asset: string
    rail: 'x402' | 'stripe'
  } | null>(null)
  const polling = useRef<number | null>(null)

  // Ask the door what it wants. This signs in as the account the card will
  // use, so the session paid for here is the session it opens later.
  useEffect(() => {
    let alive = true
    void cookrew()
      .serveGate(link)
      .then((result) => {
        if (!alive) return
        setBusy(false)
        if (result.ok) {
          setPhase(result.phase)
          setWallet(result.wallet)
        } else {
          setPhase({ kind: 'error', status: 0 })
          setFault({
            voice: 'apolog',
            title: MKT_PAY['mkt.pay.error.unverifiable.title'],
            body: result.detail ?? MKT_PAY['mkt.pay.error.unverifiable.body']
          })
        }
      })
      .catch(() => {
        if (alive) {
          setBusy(false)
          setPhase({ kind: 'error', status: 0 })
        }
      })
    return () => {
      alive = false
      if (polling.current !== null) window.clearInterval(polling.current)
    }
  }, [link])

  // The quote's own clock. The sheet only quotes what it is given, so the
  // countdown is ticked here.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const rails: ServeRail[] = phase?.kind === 'pay' ? phase.rails : []
  const selected = useMemo(
    () => rails.find((rail) => rail.rail === railId) ?? rails[0] ?? null,
    [rails, railId]
  )

  // The chip row IS the rail choice. A wallet chip names the wallet that would
  // sign, because a person about to move money should never have to guess.
  const wallets: WalletChoice[] = rails.map((rail) =>
    rail.rail === 'stripe'
      ? { id: 'stripe', label: MKT_PAY['mkt.pay.rail.card'], icon: '▭' }
      : {
          id: 'x402',
          label: wallet
            ? fillCopy(MKT_PAY['mkt.pay.rail.usdc'], { wallet: shortAddress(wallet.address) })
            : MKT_PAY['mkt.pay.rail.usdc.nowallet'],
          icon: '◈'
        }
  )

  const applyPhase = useCallback(
    (next: ServePhase): void => {
      setPhase(next)
      if (next.kind === 'denied') {
        if (next.reason === 'payment_invalid') {
          setFault({
            voice: 'accuse',
            title: MKT_PAY['mkt.pay.error.invalid.title'],
            body: MKT_PAY['mkt.pay.error.invalid.body']
          })
        } else if (next.reason === 'payment_unverifiable') {
          setFault({
            voice: 'apolog',
            title: MKT_PAY['mkt.pay.error.unverifiable.title'],
            body: MKT_PAY['mkt.pay.error.unverifiable.body']
          })
        }
      }
    },
    []
  )

  /** Poll for a card payment landing. It unlocks itself; the user may leave. */
  const waitForCard = useCallback(
    (session: string): void => {
      let attempts = 0
      polling.current = window.setInterval(() => {
        attempts += 1
        if (attempts > POLL_LIMIT) {
          if (polling.current !== null) window.clearInterval(polling.current)
          setBusy(false)
          return
        }
        void cookrew()
          .serveSettle(link, 'stripe', session)
          .then((result) => {
            // A not-yet-paid session answers `invalid` every time we look. That
            // is the poll working, not the caller being accused — only a
            // finished poll speaks.
            if (!result.ok || result.phase.kind !== 'open') return
            if (polling.current !== null) window.clearInterval(polling.current)
            setBusy(false)
            setFault(null)
            if (selected?.rail === 'stripe') {
              setSettledOn({ price: selected.price, asset: selected.asset, rail: 'stripe' })
            }
            applyPhase(result.phase)
          })
          .catch(() => undefined)
      }, POLL_MS)
    },
    [link, applyPhase]
  )

  const pay = useCallback((): void => {
    if (!selected) return
    setFault(null)
    setBusy(true)
    if (selected.rail === 'stripe') {
      void cookrew()
        .serveCheckout(link)
        .then((result) => {
          if (!result.ok) {
            setBusy(false)
            setFault({
              voice: 'apolog',
              title: MKT_PAY['mkt.pay.error.unverifiable.title'],
              body: result.detail ?? MKT_PAY['mkt.pay.error.unverifiable.body']
            })
            return
          }
          // Stays busy on purpose: the wallet/card is in charge now, and a live
          // PAY button here is how a person pays twice.
          waitForCard(result.session)
        })
        .catch(() => setBusy(false))
      return
    }
    if (!wallet) {
      setBusy(false)
      setFault({
        voice: 'apolog',
        title: MKT_PAY['mkt.pay.error.nowallet.title'],
        body: MKT_PAY['mkt.pay.error.nowallet.body']
      })
      return
    }
    void cookrew()
      .serveSettle(link, 'x402')
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          if (result.phase.kind === 'open') {
            setSettledOn({ price: selected.price, asset: selected.asset, rail: 'x402' })
          }
          applyPhase(result.phase)
        } else {
          setFault({
            voice: 'apolog',
            title: MKT_PAY['mkt.pay.error.unverifiable.title'],
            body: result.detail ?? MKT_PAY['mkt.pay.error.unverifiable.body']
          })
        }
      })
      .catch(() => setBusy(false))
  }, [selected, link, wallet, waitForCard, applyPhase])

  const gatePhase: GatePhase = (() => {
    if (phase === null) return { kind: 'identify' }
    switch (phase.kind) {
      case 'open':
        return { kind: 'open' }
      case 'pay':
        return { kind: 'pay' }
      case 'denied':
        // A payment fault is shown ON the pay step, in its own voice — the
        // walk only leaves the rail for refusals the caller cannot answer.
        return phase.reason === 'payment_invalid' || phase.reason === 'payment_unverifiable'
          ? { kind: 'pay' }
          : { kind: 'denied', reason: phase.reason, retryable: phase.retryable }
      case 'gone':
        return { kind: 'gone' }
      case 'error':
        return { kind: 'error', status: phase.status }
    }
  })()

  const priceLine =
    selected !== null
      ? `${selected.price} ${selected.asset} · ${fillCopy(MKT_PAY['mkt.pay.destination'], {
          author: `@${face.slug}`
        })}`
      : null

  return (
    <GateSheet
      scene={{
        door: 'install',
        phase: gatePhase,
        pricing:
          selected === null
            ? null
            : {
                model: 'one-time',
                terms: {
                  price: selected.price,
                  asset: selected.asset,
                  chain: selected.chain,
                  author: `@${face.slug}`,
                  expiry: selected.expiry
                }
              }
      }}
      title={face.name}
      version={`V${face.version}`}
      agentCount={face.agents}
      bannerLine={priceLine}
      wallets={wallets}
      selectedWallet={selected?.rail ?? null}
      quoteRemaining={selected ? remaining(selected.expiry, now) : null}
      busy={busy}
      fault={fault}
      deniedVars={{ presetName: face.name, author: `@${face.slug}` }}
      onDismiss={onDismiss}
      onSelectWallet={(id) => {
        setRailId(id)
        setFault(null)
      }}
      onPay={pay}
      // Only a rail we actually SETTLED on counts as paid. Arriving at `open`
      // because a session was already running is not a purchase, and a card
      // that claimed one would be inventing a receipt.
      onServe={() => onOpen(settledOn ?? undefined)}
      onRemedy={onDismiss}
    />
  )
}
