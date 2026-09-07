import { BRAND_LOCKUP_PNG } from './brand-lockup-png'
import { C_HAND_INK_PNG } from './brand-c-hand-png'

/** The Cookrew mark in the header: the static brand lockup — the C hand, the two lens eyes and
    KREW — drawn in ink straight on the cream, no chip. The moving version (the tank and the
    pac-man taking turns) lives on cookrew.dev; the app keeps the still. */
export function CrLogoMark(): React.JSX.Element {
  return (
    <span className="cr-logo-mark" role="img" aria-label="Cookrew">
      <img src={BRAND_LOCKUP_PNG} alt="" draggable={false} />
    </span>
  )
}

/** The C hand on its own: the phone bar's mark. The bar is one line at phone width, so the
    lockup gives way to the hand and the path badge beside it does the refreshing. */
export function CrHandMark(): React.JSX.Element {
  return (
    <span className="cr-hand-mark" role="img" aria-label="Cookrew">
      <img src={C_HAND_INK_PNG} alt="" draggable={false} />
    </span>
  )
}
