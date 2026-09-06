import { WIRE_HAND_64 } from '../../shared/brand-hand'

/**
 * Cookrew logo mark: the owner's cyan wireframe render of a machine hand
 * making a C (shared/brand-hand.ts — the same bytes the site's favicon
 * carries). It sits on its own dark tile so the cyan reads on the cream
 * bar. Ruled 2026-09-06; the two-finger baby hand is in git history.
 */
export function CrLogoMark({
  className = 'cr-logo-mark',
}: {
  /** The bar's mark is `cr-logo-mark`, which the companion drops for the
   *  path badge; the small typing hand in the lockup is the same picture
   *  under another name, so that rule cannot mistake it for the mark. */
  className?: string
} = {}): React.JSX.Element {
  return (
    <img
      className={className}
      src={WIRE_HAND_64}
      alt="Cookrew logo: a wireframe hand making a C"
      draggable={false}
    />
  )
}
