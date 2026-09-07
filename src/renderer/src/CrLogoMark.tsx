import { BRAND_LOCKUP_PNG } from './brand-lockup-png'
import { C_HAND_INK_PNG } from './brand-c-hand-png'
import { BRAND_MOTION_HTML } from './brand-motion-html'

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

/** The moving lockup for the phone bar in landscape: the tank and the pac-man taking turns, the
    eyes alive, in ink on the cream. brand-motion.css shows it from 700 px up and hides the hand;
    reduced-motion pauses it. The markup is a generated constant, so innerHTML is safe here. */
export function CrBrandMotion(): React.JSX.Element {
  return (
    <span
      className="cr-brand-motion"
      role="img"
      aria-label="Cookrew"
      dangerouslySetInnerHTML={{ __html: BRAND_MOTION_HTML }}
    />
  )
}
