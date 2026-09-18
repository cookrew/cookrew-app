import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew, type ServeFacePreview, type ServePhase, type ServeRail } from './api'
import { GateSheet, type PayFault, type WalletChoice } from './GateSheet'
import type { GatePhase } from '../../shared/gate-walk'
import type { CanvasNode } from '../../shared/model'
import { MKT_PAY, fillCopy } from '../../shared/marketplace-copy'
import { requestAccountSheet } from './account/open-request'
import {
  BUDGET_RETRY_MS,
  deniedVarsFor,
  remedyFor,
  walkPricing,
  type GateFacts
} from './import-gate-remedy'

/**
 * THE IMPORT, through the one Gate Sheet.
 *
 * A served team is met the same way every other gated thing in Cookrew is met:
 * identify → seat → pay → open, painted by `gateWalk`. This component is the
 * ceremony the sheet deliberately does not host — it asks the door what it
 * wants, offers the rails the door actually advertises, carries out the
 * payment on the chosen one, and re-renders the sheet with what came back.
 *
 * WHICH DOOR — main decides (identity v3, G1/G3). A LISTED team is entered as
 * the account: with no account on this Mac the door answers `identify`, the
 * SIGN IN primary opens the account sheet IN PLACE, and the gate re-runs
 * itself when the account changes — the sheet never closes to sign in. An
 * unlisted door is the DIRECT walk, this Mac's own key, and says so.
 *
 * WHERE THE MONEY IS HANDLED. Not here. The renderer names a door and a rail;
 * the main process holds the Bearer, signs the transfer authorization with the
 * wallet this device provisioned, and talks to Stripe. A key never crosses IPC.
 *
 * EVERY REFUSAL GOES SOMEWHERE (G2/G4). A 403's button used to close the sheet
 * while naming a destination. Now `remedyFor` says what it does — the team's
 * page in a browser card, or asking again — and a 429 asks again on its own
 * in fifteen minutes, as its sentence promises.
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

const NO_FACTS: GateFacts = { door: 'install', team: null, owner: null, account: null }

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
  const [facts, setFacts] = useState<GateFacts>(NO_FACTS)
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
  const alive = useRef(true)

  // Ask the door what it wants. Main signs in as the account the card will
  // use, so the session paid for here is the session it opens later.
  const runGate = useCallback((): void => {
    setBusy(true)
    setFault(null)
    void cookrew()
      .serveGate(link)
      .then((result) => {
        if (!alive.current) return
        setBusy(false)
        if (result.ok) {
          setPhase(result.phase)
          setWallet(result.wallet)
          setFacts({
            door: result.door,
            team: result.team ?? null,
            owner: result.owner ?? null,
            account: result.account ?? null
          })
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
        if (alive.current) {
          setBusy(false)
          setPhase({ kind: 'error', status: 0 })
        }
      })
  }, [link])

  useEffect(() => {
    alive.current = true
    runGate()
    return () => {
      alive.current = false
      if (polling.current !== null) window.clearInterval(polling.current)
    }
  }, [runGate])

  // THE WALK RESUMES ON ITS OWN. The person signed in — here, in the header,
  // on the lock screen; main says the account changed — and a listed door is
  // asked again without the sheet ever having closed.
  useEffect(() => {
    const off = cookrew().onAccountChanged?.(() => {
      if (facts.door === 'install') runGate()
    })
    return off
  }, [facts.door, runGate])

  // A 429 is the owner's lending limit, which passes with time. The sentence
  // says the sheet will try again in fifteen minutes, so it does.
  useEffect(() => {
    if (phase?.kind !== 'denied' || phase.reason !== 'budget') return
    const timer = window.setTimeout(runGate, BUDGET_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [phase, runGate])

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
    [link, applyPhase, selected]
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

  /**
   * The identify step's primary. On the install walk it opens the account
   * sheet over this one; the walk resumes through `onAccountChanged`. On the
   * direct walk main already offered the key, so CONNECT is asking again.
   */
  const identify = useCallback((): void => {
    if (facts.door === 'direct' || !requestAccountSheet()) runGate()
  }, [facts.door, runGate])

  /** A refusal's one forward action — it goes where its label says. */
  const remedy = useCallback(
    (reason: string): void => {
      const act = remedyFor(reason, facts.team)
      if (act.kind === 'retry') {
        runGate()
        return
      }
      // The team's page, on the canvas beside this sheet rather than in a
      // browser the person then has to find their way back from.
      const card: CanvasNode = {
        kind: 'browser',
        id: crypto.randomUUID(),
        name: 'Browser',
        url: act.url,
        position: { x: 160, y: 120 },
        size: { width: 720, height: 560 }
      }
      void cookrew()
        .addNode(card)
        .catch(() => undefined)
    },
    [facts.team, runGate]
  )

  const gatePhase: GatePhase = (() => {
    if (phase === null) return { kind: 'identify' }
    switch (phase.kind) {
      case 'identify':
        return { kind: 'identify' }
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

  const pricing = walkPricing(face, selected)
  const priceLine =
    selected !== null
      ? `${selected.price} ${selected.asset} · ${fillCopy(MKT_PAY['mkt.pay.destination'], {
          author: `@${facts.owner ?? face.slug}`
        })}`
      : null
  // Who this Mac is at the door, once known — the usual cause of a refusal
  // is being signed in as somebody else, so the banner says who.
  const bannerLine = priceLine ?? (facts.account ? `You are @${facts.account}` : null)

  return (
    <GateSheet
      scene={{ door: facts.door, phase: gatePhase, pricing }}
      title={face.name}
      version={`V${face.version}`}
      agentCount={face.agents}
      bannerLine={bannerLine}
      wallets={wallets}
      selectedWallet={selected?.rail ?? null}
      quoteRemaining={selected ? remaining(selected.expiry, now) : null}
      busy={busy}
      fault={fault}
      deniedVars={deniedVarsFor(face, facts)}
      onDismiss={onDismiss}
      onIdentify={identify}
      onSelectWallet={(id) => {
        setRailId(id)
        setFault(null)
      }}
      onPay={pay}
      // Only a rail we actually SETTLED on counts as paid. Arriving at `open`
      // because a session was already running is not a purchase, and a card
      // that claimed one would be inventing a receipt.
      onServe={() => onOpen(settledOn ?? undefined)}
      onRemedy={remedy}
    />
  )
}
