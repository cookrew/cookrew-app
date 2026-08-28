import { useEffect, useMemo, useRef } from 'react'
import {
  gateWalk,
  type GateScene,
  type WalkPricing,
  type WalkStep
} from '../../shared/gate-walk'
import { MKT_AUTH, MKT_ENROL, MKT_GATE, MKT_PAY, fillCopy } from '../../shared/marketplace-copy'
import { deniedBand, identifyBand, openBand, payBand, type BandCopy } from './gate-sheet-copy'
import './gate-sheet.css'

/**
 * THE GATE SHEET (R28) — one surface answers the gate: 401 identify · 402 pay ·
 * open. It renders `gateWalk(scene)` and nothing else, so what the user sees is
 * a picture of `decideGate`'s order: a step the gate never demands is a dashed
 * tick, never hidden, and a cleared step collapses to a receipt band so the
 * sheet gets shorter as it succeeds.
 *
 * WHAT THIS COMPONENT DOES NOT DO. It mounts no ceremony. The passkey, the
 * wallet transfer and the six-word enrolment happen in their own machinery
 * (Forge's payment client, the accounts service, the grant surface); this sheet
 * calls back to them and paints their result. Keeping the ceremonies out is
 * what lets the sheet be a pure projection of the gate, testable without a
 * wallet, a passkey or a network.
 *
 * THE PRIMARY IS A POINTER ACT. Enrolment and payment are the two irreversible
 * moments, so — as the grant sheet already rules — the primary is never focused
 * on open and Enter never fires it. Escape closes; nothing else commits.
 */

/** An EIP-6963-discovered wallet, as a chip. */
export interface WalletChoice {
  id: string
  label: string
  icon?: string
}

/** A payment failure, in one of two voices (R-two-voices): accuse vs apologise. */
export interface PayFault {
  voice: 'accuse' | 'apolog'
  title: string
  body: string
}

export interface GateSheetProps {
  scene: GateScene
  /** The crew or line being gated, e.g. 'RESEARCH CREW'. */
  title: string
  /** Head chip — the version, e.g. 'V4'. */
  version?: string | null
  /** Head chip — agent count, when known. */
  agentCount?: number | null
  /** The amber banner line: a price line (install) or a grant line (call). */
  bannerLine?: string | null
  /** The six words, for the call door's live identify step. */
  words?: readonly string[] | null
  /** Wallets discovered on this device, for the pay step. */
  wallets?: readonly WalletChoice[]
  selectedWallet?: string | null
  /** A human "4 min"-style remaining, so the sheet quotes an expiry deterministically. */
  quoteRemaining?: string | null
  busy?: boolean
  fault?: PayFault | null
  /** Where a 403 points the buyer (author page, top-up, seat purchase). */
  deniedRemedy?: string
  /** The facts a refusal's copy needs — presetName, amount, seat counts, etc. */
  deniedVars?: Readonly<Record<string, string | number>>
  onDismiss: () => void
  /** Sign in (install) or "I read these aloud · connect" (call). */
  onIdentify?: () => void
  onSelectWallet?: (id: string) => void
  onPay?: () => void
  /** Acknowledge the served state — DONE. */
  onServe?: () => void
  /** The one forward action on a 403. */
  onRemedy?: (reason: string) => void
}

/** The gate-band CSS variant for a step's band. */
function bandClass(step: WalkStep): string {
  switch (step.band) {
    case '401':
      return 'gate-401'
    case '402':
      return 'gate-402'
    case 'open':
      return 'gate-open'
    default:
      return ''
  }
}

/** Resolve one step's band copy from the door and its cleared/live state. */
function stepBand(step: WalkStep, door: GateScene['door'], pricing: WalkPricing | null): BandCopy | null {
  if (step.band === null) return null
  switch (step.id) {
    case 'identify':
      return identifyBand(door, step.state === 'done')
    case 'pay':
      return pricing ? payBand(pricing) : null
    case 'open':
      return openBand(door)
  }
}

function Band({ variant, copy }: { variant: string; copy: BandCopy }): React.JSX.Element {
  return (
    <div className={`gate-band ${variant}`}>
      <span className="glyph">{copy.glyph}</span>
      <div>
        <div className="said">{copy.said}</div>
        <div className="why">{copy.why}</div>
      </div>
    </div>
  )
}

/** The six words, large, because two humans read them aloud (R-enrol). */
function SixWords({ words }: { words: readonly string[] }): React.JSX.Element {
  return (
    <div className="gk-sec">
      <div className="gk-six">
        {words.map((w, i) => (
          <span key={`${w}-${i}`}>{w}</span>
        ))}
      </div>
      <p className="gk-fine">{MKT_ENROL['mkt.enrol.body']}</p>
    </div>
  )
}

/** The 402 terms and the wallet chips — the money, laid out before approval. */
function PayBody({
  pricing,
  wallets,
  selectedWallet,
  quoteRemaining,
  onSelectWallet
}: {
  pricing: WalkPricing
  wallets: readonly WalletChoice[]
  selectedWallet: string | null
  quoteRemaining: string | null
  onSelectWallet?: (id: string) => void
}): React.JSX.Element {
  const { terms } = pricing
  return (
    <>
      <div className="gk-sec">
        <div className="gk-label">{MKT_GATE['mkt.gate.terms.head']}</div>
        <div className="gk-row">
          <span className="k">{MKT_GATE['mkt.gate.terms.price']}</span>
          <span className="v">
            {terms.price} {terms.asset}
          </span>
        </div>
        <div className="gk-row">
          <span className="k">{MKT_GATE['mkt.gate.terms.chain']}</span>
          <span className="v">{terms.chain}</span>
        </div>
        <div className="gk-row">
          <span className="k">{MKT_GATE['mkt.gate.terms.paidto']}</span>
          <span className="v">{terms.author}</span>
          <span className="cr-chip">{MKT_GATE['mkt.gate.terms.author']}</span>
        </div>
        {quoteRemaining && (
          <div className="gk-row">
            <span className="k">{MKT_GATE['mkt.gate.terms.quoteends']}</span>
            <span className="v">{fillCopy(MKT_PAY['mkt.pay.expires'], { mmss: quoteRemaining })}</span>
          </div>
        )}
      </div>
      <div className="gk-sec">
        <div className="gk-label">{MKT_PAY['mkt.pay.choose'].toUpperCase()}</div>
        <div className="gk-chips">
          {wallets.length === 0 ? (
            <p className="gk-fine">{MKT_PAY['mkt.pay.choose.none']}</p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                aria-pressed={w.id === selectedWallet}
                className={`cr-chip clickable${w.id === selectedWallet ? ' sel' : ''}`}
                onClick={() => onSelectWallet?.(w.id)}
              >
                {w.icon ? `${w.icon} ` : ''}
                {w.label}
              </button>
            ))
          )}
        </div>
      </div>
      <p className="tf-hint">{MKT_PAY['mkt.pay.custody']}</p>
    </>
  )
}

/** The two-voice fault strip: an accusation names the payment, an apology names us. */
function FaultStrip({ fault }: { fault: PayFault }): React.JSX.Element {
  return (
    <div className={`gk-err ${fault.voice === 'accuse' ? 'accuse' : 'apolog'}`} role="alert">
      <b>{fault.title}</b>
      <i>{fault.body}</i>
    </div>
  )
}

/** The footer primary for the live step — label, handler and whether it's a stop. */
function primaryFor(
  active: WalkStep | undefined,
  door: GateScene['door'],
  pricing: WalkPricing | null,
  props: GateSheetProps
): { label: string; onClick?: () => void } | null {
  if (!active) return null
  switch (active.id) {
    case 'identify':
      return door === 'call'
        ? { label: MKT_ENROL['mkt.enrol.action.caller'], onClick: props.onIdentify }
        : { label: MKT_AUTH['mkt.auth.action'], onClick: props.onIdentify }
    case 'pay':
      return pricing
        ? {
            label: props.selectedWallet
              ? fillCopy(MKT_PAY['mkt.pay.action.pay'], {
                  price: pricing.terms.price,
                  asset: pricing.terms.asset
                })
              : MKT_PAY['mkt.pay.action.connect'],
            onClick: props.selectedWallet ? props.onPay : undefined
          }
        : null
    case 'open':
      return { label: MKT_GATE['mkt.gate.open.action'], onClick: props.onServe }
  }
}

export function GateSheet(props: GateSheetProps): React.JSX.Element {
  const {
    scene,
    title,
    version = null,
    agentCount = null,
    bannerLine = null,
    words = null,
    wallets = [],
    selectedWallet = null,
    quoteRemaining = null,
    busy = false,
    fault = null,
    deniedRemedy,
    deniedVars = {},
    onDismiss,
    onRemedy
  } = props
  const walk = useMemo(() => gateWalk(scene), [scene])
  const pricing = scene.pricing ?? null
  const panelRef = useRef<HTMLDivElement>(null)

  // The panel takes focus on mount so Escape works before the user clicks —
  // the keydown handler lives on the panel, and keydown only bubbles from a
  // focused descendant. Untested here (no DOM effects), so it is written to be
  // obviously correct rather than relied on to be caught.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const shell = (inner: React.JSX.Element, foot: React.JSX.Element): React.JSX.Element => (
    <div className="gk-scrim">
      <div
        ref={panelRef}
        className="tf-panel gk-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDismiss()
        }}
      >
        <header className="tf-head">
          <span className="tf-title">{title}</span>
          {version && <span className="cr-chip-ver">{version}</span>}
          <span className="tf-spacer" />
          {agentCount != null && (
            <span className="cr-chip">{fillCopy(MKT_GATE['mkt.gate.agents'], { n: agentCount })}</span>
          )}
        </header>
        {bannerLine && (
          <div className="tf-banner">
            <span className="who">{bannerLine}</span>
          </div>
        )}
        {inner}
        {foot}
      </div>
    </div>
  )

  // ── Refusals — bands without a rail. A 403 is not a place on the journey. ──
  if (walk.kind === 'denied') {
    const band = deniedBand(walk.reason, deniedRemedy, deniedVars)
    const variant = walk.band === '403-credit' ? 'gate-403 empty-credit' : 'gate-403'
    return shell(
      <div className="gk-main">
        <Band variant={variant} copy={band} />
      </div>,
      <footer className="tf-foot">
        <button type="button" className="cr-btn ghost" onClick={onDismiss}>
          {MKT_PAY['mkt.pay.dismiss']}
        </button>
        <span className="tf-spacer" />
        <button
          type="button"
          className={`cr-btn ${walk.band === '403-credit' ? 'primary' : ''}`}
          onClick={() => onRemedy?.(walk.reason)}
        >
          {band.action}
        </button>
      </footer>
    )
  }

  if (walk.kind === 'gone' || walk.kind === 'error') {
    const said = walk.kind === 'gone' ? MKT_GATE['mkt.gate.gone.title'] : MKT_GATE['mkt.gate.error.title']
    const why = walk.kind === 'gone' ? MKT_GATE['mkt.gate.gone.why'] : MKT_GATE['mkt.gate.error.why']
    return shell(
      <div className="gk-main">
        <div className="gate-band gate-403">
          <span className="glyph">✕</span>
          <div>
            <div className="said">{said}</div>
            <div className="why">{why}</div>
          </div>
        </div>
      </div>,
      <footer className="tf-foot">
        <span className="tf-spacer" />
        <button type="button" className="cr-btn" onClick={onDismiss}>
          {MKT_PAY['mkt.pay.dismiss']}
        </button>
      </footer>
    )
  }

  // ── The walk — rail + bands + the live step's body. ──
  const { steps, door, pin } = walk
  const active = steps.find((s) => s.state === 'now')
  const primary = primaryFor(active, door, pricing, props)

  return shell(
    <div className="gk-body">
      <div className="gk-rail" aria-hidden="true">
        {steps.map((s, i) => (
          <div key={s.id} className="gk-rail-node">
            <div className={`gk-tick ${s.state}`} />
            {(i < steps.length - 1 || pin) && <div className="gk-link" />}
          </div>
        ))}
        {pin && <div className="gk-pin">{pin}</div>}
      </div>
      <div className="gk-main">
        {steps.map((s) => {
          const copy = stepBand(s, door, pricing)
          return copy ? <Band key={s.id} variant={bandClass(s)} copy={copy} /> : null
        })}

        {active?.id === 'identify' && door === 'call' && words && <SixWords words={words} />}
        {active?.id === 'identify' && door === 'install' && (
          <p className="tf-hint">{MKT_AUTH['mkt.auth.custody']}</p>
        )}
        {active?.id === 'pay' && pricing && (
          <PayBody
            pricing={pricing}
            wallets={wallets}
            selectedWallet={selectedWallet}
            quoteRemaining={quoteRemaining}
            onSelectWallet={props.onSelectWallet}
          />
        )}
        {active?.id === 'open' && (
          <div className="gk-rcpt">
            <div className="r1">
              {pin && <span className="gk-pin">{pin}</span>} {MKT_GATE['mkt.gate.pin']}
            </div>
            <div className="r2">{MKT_GATE['mkt.gate.pin.why']}</div>
          </div>
        )}
        {door === 'call' && active?.id === 'identify' && (
          <p className="gk-fine">{MKT_GATE['mkt.gate.warming']}</p>
        )}
        {fault && <FaultStrip fault={fault} />}
      </div>
    </div>,
    <footer className="tf-foot">
      <button type="button" className="cr-btn ghost" onClick={onDismiss}>
        {MKT_PAY['mkt.pay.dismiss']}
      </button>
      <span className="tf-spacer" />
      {primary && (
        <button type="button" className="cr-btn primary" disabled={busy || !primary.onClick} onClick={primary.onClick}>
          {busy ? '…' : primary.label}
        </button>
      )}
    </footer>
  )
}
