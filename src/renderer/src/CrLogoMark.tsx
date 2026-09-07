import { BRAND_LOCKUP_PNG } from './brand-lockup-png'

/** The Cookrew mark in the header: the static brand lockup — the C hand, the two lens eyes and
    KREW — amber, sitting on a dark chip the way it sits on the terminal. The moving version
    (the tank and the pac-man taking turns) lives on cookrew.dev; the app keeps the still. */
export function CrLogoMark(): React.JSX.Element {
  return (
    <span className="cr-logo-mark" role="img" aria-label="Cookrew">
      <img src={BRAND_LOCKUP_PNG} alt="" draggable={false} />
    </span>
  )
}
