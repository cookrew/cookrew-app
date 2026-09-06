import { handCuff, handMesh, handOutline } from '../../shared/brand-mark'

/**
 * Cookrew logo mark: a wireframe machine hand making a C. The geometry lives
 * in shared/brand-mark.ts and is the same three paths the site draws; every
 * stroke is currentColor, so the mark is ink on the cream bar and cyan on a
 * phosphor ground. The two-finger baby hand this replaces is in git history
 * (owner ruling, 2026-09-06).
 */
export function CrLogoMark({
  plain = false,
  className = 'cr-logo-mark',
}: {
  plain?: boolean
  /** The bar's mark is `cr-logo-mark`, which the companion drops for the path
   *  badge; the small typing hand in the lockup is the same drawing under
   *  another name, so that rule cannot mistake it for the mark. */
  className?: string
} = {}): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Cookrew logo: a wireframe hand making a C"
    >
      <path d={handOutline()} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      {!plain && (
        <path
          d={handMesh()}
          fill="none"
          stroke="currentColor"
          strokeWidth="0.6"
          strokeLinecap="round"
          opacity="0.85"
        />
      )}
      <path d={handCuff()} fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  )
}
