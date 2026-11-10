import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew, type ServeFacePreview, type ServePhase, type ServeRail } from './api'
import { GateSheet, type PayFault, type WalletChoice } from './GateSheet'
import type { GatePhase } from '../../shared/gate-walk'
import { MKT_PAY, fillCopy } from '../../shared/marketplace-copy'
import { requestAccountSheet } from './account/open-request'
import {
  CARD_POLL_MS,
  cardCheckStep,
  cardPollStep,
  type CardStep,
  type CardWait,
  type SettleAnswer
} from './card-wait'
import {
  BUDGET_RETRY_MS,
  deniedVarsFor,
  displayedTermsKey,
  remedyFor,
  settleRefusalFault,
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
 * A CARD IS WAITED ON FOR AS LONG AS IT CAN BE PAID (card-wait.ts). The
 * sheet asks the door about ONE Checkout session until that session's life is
 * over. If the wait ends, or the door refuses for a reason that is not the
 * payment, the sheet says so and the button becomes CHECK AGAIN — the same
 * session, asked about once more. A new card page is started only after the
 * door has said the old one went unpaid, because two pages are two charges.
 *
 * EVERY REFUSAL GOES SOMEWHERE (G2/G4). A 403's button used to close the sheet
 * while naming a destination. Now `remedyFor` says what it does — asking the
 * door again — and a 429 asks again on its own in fifteen minutes, as its
 * sentence promises.
 *
 * A SEAT IS BOUGHT HERE (0.6.0). The seat step's BUY A SEAT asks the gate
 * again with the intent to buy; the door answers with its price and rails and
 * the sheet moves to the pay step it has always had. Nothing is charged by
 * the press, and no web page is opened — the team's page that used to sell
 * the seat no longer exists.
 */

/** A card payment the sheet is waiting on, or holding until CHECK AGAIN is pressed. */
interface CardState {
  wait: CardWait
  /** What that session was quoted at — the receipt, if it is paid. */
  paid: { price: string; asset: string }
  /**
   * `waiting`: the sheet asks by itself, button held. `check`: it stopped, and
   * says so. `resume`: the sheet was OPENED on a payment already in flight —
   * it asks by itself, and the button reopens that payment's own card page.
   */
  mode: 'waiting' | 'check' | 'resume'
}

/** Said when the sheet opens on a card payment made earlier and still payable. */
const RESUME_FAULT: PayFault = {
  voice: 'apolog',
  title: MKT_PAY['mkt.pay.card.resume.title'],
  body: MKT_PAY['mkt.pay.card.resume.body']
}

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

const EMPTY_RAILS: ServeRail[] = []
const NO_FACTS: GateFacts = { door: 'install', team: null, owner: null, account: null, seat: null }

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
  /** The rails the door last quoted — what the pay step offers (see `rails` below). */
  const [quotedRails, setQuotedRails] = useState<ServeRail[]>(EMPTY_RAILS)
  const [card, setCard] = useState<CardState | null>(null)
  /** The same card, readable from a timer without a stale closure. */
  const cardRef = useRef<CardState | null>(null)
  const polling = useRef<number | null>(null)
  /** One look at the door at a time: a slow answer must not be overtaken by the next tick. */
  const looking = useRef(false)
  const alive = useRef(true)

  const stopPolling = useCallback((): void => {
    if (polling.current !== null) window.clearInterval(polling.current)
    polling.current = null
  }, [])

  const holdCard = useCallback((next: CardState | null): void => {
    cardRef.current = next
    setCard(next)
  }, [])

  /** Paint what main said about the door: the phase, the wallet, the facts its sentences name. */
  const applyGate = useCallback((result: Awaited<ReturnType<ReturnType<typeof cookrew>['serveGate']>>): void => {
    setBusy(false)
    if (result.ok) {
      setPhase(result.phase)
      setQuotedRails(result.phase.kind === 'pay' ? result.phase.rails : EMPTY_RAILS)
      // A CARD PAYMENT MADE EARLIER (main remembers it, on disk). Landed: this
      // is its receipt, and the phase is already `open`. Still payable: the
      // sheet takes up THAT session — main's word on which, never this
      // sheet's memory — and offers its page again instead of a new payment.
      if (result.settled) setSettledOn(result.settled)
      const flying = result.card
      const holding = cardRef.current
      if (flying === undefined) {
        if (holding !== null) {
          stopPolling()
          holdCard(null)
        }
      } else if (holding === null || holding.wait.session !== flying.session) {
        holdCard({
          wait: { session: flying.session, startedAt: flying.startedAt },
          paid: { price: flying.price, asset: 'USD' },
          mode: 'resume'
        })
        setFault(RESUME_FAULT)
      }
      setWallet(result.wallet)
      setFacts({
        door: result.door,
        team: result.team ?? null,
        owner: result.owner ?? null,
        account: result.account ?? null,
        seat: result.seat ?? null
      })
    } else {
      setPhase({ kind: 'error', status: 0 })
      setFault({
        voice: 'apolog',
        title: MKT_PAY['mkt.pay.error.unverifiable.title'],
        body: result.detail ?? MKT_PAY['mkt.pay.error.unverifiable.body']
      })
    }
  }, [holdCard, stopPolling])

  // Ask the door what it wants. Main signs in as the account the card will
  // use, so the session paid for here is the session it opens later. `intent`
  // is the BUY A SEAT press and nothing else: every other ask — the first,
  // a retry, the one after signing in — is a plain import.
  const runGate = useCallback((intent?: 'buy'): void => {
    setBusy(true)
    setFault(null)
    void cookrew()
      .serveGate(link, intent)
      .then((result) => {
        if (alive.current) applyGate(result)
      })
      .catch(() => {
        if (alive.current) {
          setBusy(false)
          setPhase({ kind: 'error', status: 0 })
        }
      })
  }, [link, applyGate])

  useEffect(() => {
    alive.current = true
    runGate()
    return () => {
      alive.current = false
      stopPolling()
    }
  }, [runGate, stopPolling])

  // THE WALK RESUMES ON ITS OWN. The person signed in — here, in the header,
  // on the lock screen; main says the account changed — and a listed door is
  // asked again without the sheet ever having closed.
  //
  // WHILE A CARD IS BEING WAITED ON the event is weighed first. The account
  // announces many things that are not a change of hands, and the wait must
  // survive those: a paid session nobody presents is money for nothing. So
  // the door is asked who this Mac is now, and only a DIFFERENT person stops
  // the wait — their sheet must not go on presenting somebody else's payment.
  useEffect(() => {
    const off = cookrew().onAccountChanged?.(() => {
      if (facts.door !== 'install') return
      if (cardRef.current === null) {
        runGate()
        return
      }
      void cookrew()
        .serveGate(link)
        .then((result) => {
          if (!alive.current) return
          if (result.ok && (result.account ?? null) === facts.account) return
          stopPolling()
          holdCard(null)
          setFault(null)
          applyGate(result)
        })
        .catch(() => undefined)
    })
    return off
  }, [facts.door, facts.account, link, runGate, applyGate, stopPolling, holdCard])

  // A 429 is the owner's lending limit, which passes with time. The sentence
  // says the sheet will try again in fifteen minutes, so it does.
  useEffect(() => {
    if (phase?.kind !== 'denied' || phase.reason !== 'budget') return
    const timer = window.setTimeout(() => runGate(), BUDGET_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [phase, runGate])

  // The quote's own clock. The sheet only quotes what it is given, so the
  // countdown is ticked here.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // THE RAILS OUTLIVE A REFUSED PAYMENT. A payment the door would not take is
  // shown ON the pay step — and that step used to lose its rails the moment
  // the refusal arrived, leaving a sentence above a dead button. What the door
  // last quoted stays offered, so the person can press again or pay another way.
  const onPayStep =
    phase?.kind === 'pay' ||
    (phase?.kind === 'denied' &&
      (phase.reason === 'payment_invalid' || phase.reason === 'payment_unverifiable'))
  const rails: ServeRail[] = onPayStep ? quotedRails : EMPTY_RAILS
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
      // A settle can answer with a fresh quote (the door stopped taking USDC,
      // say): that becomes what is offered. A refusal leaves the last one be.
      if (next.kind === 'pay') setQuotedRails(next.rails)
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

  /** The facts a refusal's sentence may name, readable from the wait's timer. */
  const deniedVars = deniedVarsFor(face, facts)
  const deniedVarsRef = useRef(deniedVars)
  deniedVarsRef.current = deniedVars

  /** Carry out what one look at the door decided (card-wait.ts). */
  const actOnCard = useCallback(
    (state: CardState, step: CardStep): void => {
      switch (step.kind) {
        case 'open':
          stopPolling()
          holdCard(null)
          setBusy(false)
          setFault(null)
          setSettledOn({ ...state.paid, rail: 'stripe' })
          applyPhase({ kind: 'open' })
          return
        case 'waiting':
          // A sheet opened on an earlier payment keeps its sentence and its
          // REOPEN button while it listens: nothing has changed to say.
          if (state.mode === 'resume') return
          // Stays busy on purpose: the card page is in charge now, and a live
          // PAY button here is how a person pays twice.
          setBusy(true)
          setFault(step.fault)
          if (state.mode !== 'waiting') holdCard({ ...state, mode: 'waiting' })
          return
        case 'ended':
        case 'stopped':
          // Said, never silent — and the button that follows asks about THIS
          // session again rather than starting another.
          stopPolling()
          holdCard({ ...state, mode: 'check' })
          setBusy(false)
          setFault(step.fault)
          return
        case 'expired':
          // The door looked after the session's life was over and found no
          // payment. Only now is a new card page safe to start.
          stopPolling()
          holdCard(null)
          setBusy(false)
          setFault(step.fault)
      }
    },
    [applyPhase, holdCard, stopPolling]
  )

  /** Ask the door about the card session being held — the same one, every time. */
  const lookAtCard = useCallback(
    (decide: typeof cardPollStep, onUnreachable: () => void): void => {
      const state = cardRef.current
      if (state === null || looking.current) return
      looking.current = true
      void cookrew()
        .serveSettle(link, 'stripe', state.wait.session)
        .then((answer: SettleAnswer) => {
          looking.current = false
          // Answered for a wait that is no longer this sheet's: say nothing.
          const held = cardRef.current
          if (!alive.current || held === null || held.wait !== state.wait) return
          actOnCard(held, decide(answer, state.wait, Date.now(), deniedVarsRef.current))
        })
        .catch(() => {
          looking.current = false
          if (alive.current && cardRef.current?.wait === state.wait) onUnreachable()
        })
    },
    [link, actOnCard]
  )

  // THE TIMER FOLLOWS THE MODE. It runs while the sheet is waiting by itself
  // and at no other time — it starts when a card page is handed out, stops
  // when the wait ends or is refused, and starts again if CHECK AGAIN finds
  // the page still open for payment.
  const waiting = card?.mode === 'waiting' || card?.mode === 'resume'
  useEffect(() => {
    if (!waiting) return
    // A look that could not be made at all is not an answer: the next tick asks again.
    polling.current = window.setInterval(() => lookAtCard(cardPollStep, () => undefined), CARD_POLL_MS)
    return stopPolling
  }, [waiting, lookAtCard, stopPolling])

  /** CHECK AGAIN: one question about the session already made. Never a new Checkout. */
  const checkAgain = useCallback((): void => {
    if (cardRef.current === null) return
    setBusy(true)
    setFault(null)
    lookAtCard(cardCheckStep, () => {
      setBusy(false)
      setFault({
        voice: 'apolog',
        title: MKT_PAY['mkt.pay.error.unverifiable.title'],
        body: MKT_PAY['mkt.pay.error.unverifiable.body']
      })
    })
  }, [lookAtCard])

  /**
   * Ask main for the card page and wait on it. Main decides WHICH page: while
   * a payment for this door is in flight it hands back that one — the same
   * session, the same address — and makes a new one only when there is none.
   */
  const openCardPage = useCallback(
    (paid: { price: string; asset: string }): void => {
      setBusy(true)
      void cookrew()
        .serveCheckout(link)
        .then((result) => {
          if (!alive.current) return
          if (!result.ok) {
            setBusy(false)
            setFault({
              voice: 'apolog',
              title: MKT_PAY['mkt.pay.error.unverifiable.title'],
              body: result.detail ?? MKT_PAY['mkt.pay.error.unverifiable.body']
            })
            return
          }
          setFault(null)
          // Stays busy on purpose: the card page is in charge now.
          holdCard({
            wait: { session: result.session, startedAt: result.startedAt ?? Date.now() },
            paid,
            mode: 'waiting'
          })
        })
        .catch(() => setBusy(false))
    },
    [link, holdCard]
  )

  /** REOPEN CARD PAGE: the page of the payment already in flight, never another. */
  const reopenCard = useCallback((): void => {
    const state = cardRef.current
    if (state !== null) openCardPage(state.paid)
  }, [openCardPage])

  const pay = useCallback((): void => {
    // A card session is unresolved: whatever rail is selected, the only thing
    // this button may do is ask about it. Two payments are two charges.
    if (cardRef.current !== null) {
      checkAgain()
      return
    }
    if (!selected) return
    setFault(null)
    setBusy(true)
    if (selected.rail === 'stripe') {
      openCardPage({ price: selected.price, asset: selected.asset })
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
      // The press vouches for the terms on THIS screen (displayedTermsKey):
      // main signs only if the door's quote is still exactly those.
      .serveSettle(link, 'x402', undefined, displayedTermsKey(selected))
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          if (result.phase.kind === 'open') {
            setSettledOn({ price: selected.price, asset: selected.asset, rail: 'x402' })
          }
          applyPhase(result.phase)
        } else {
          setFault(settleRefusalFault(result))
        }
      })
      .catch(() => setBusy(false))
  }, [selected, link, wallet, applyPhase, checkAgain, openCardPage])

  /**
   * The identify step's primary. On the install walk it opens the account
   * sheet over this one; the walk resumes through `onAccountChanged`. On the
   * direct walk main already offered the key, so CONNECT is asking again.
   */
  const identify = useCallback((): void => {
    if (facts.door === 'direct' || !requestAccountSheet()) runGate()
  }, [facts.door, runGate])

  /**
   * A refusal's one forward action: the door is asked again — as a buyer when
   * the press was BUY A SEAT, plainly otherwise. The answer repaints the sheet,
   * so BUY lands on the pay step with the door's own price and rails.
   */
  const remedy = useCallback(
    (reason: string): void => {
      const act = remedyFor(reason, facts.door)
      runGate(act.kind === 'buy' ? 'buy' : undefined)
    },
    [facts.door, runGate]
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

  const pricing = walkPricing(face, selected, facts.owner)
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
      // At a listed team the pay step is reached WITHOUT a seat only by
      // buying one, so the seat tick stays ahead until the payment lands.
      scene={{
        door: facts.door,
        phase: gatePhase,
        pricing,
        buying: facts.door === 'install' && facts.seat === null
      }}
      title={face.name}
      agentCount={face.agents}
      bannerLine={bannerLine}
      wallets={wallets}
      selectedWallet={selected?.rail ?? null}
      quoteRemaining={selected ? remaining(selected.expiry, now) : null}
      busy={busy}
      fault={fault}
      deniedVars={deniedVars}
      // A card the sheet has stopped waiting on: the one thing to do is ask
      // about it again. PAY comes back only when the door says it went unpaid.
      payAction={
        card?.mode === 'check'
          ? { label: MKT_PAY['mkt.pay.card.check'], onClick: checkAgain }
          : card?.mode === 'resume'
            ? { label: MKT_PAY['mkt.pay.card.reopen'], onClick: reopenCard }
            : null
      }
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
