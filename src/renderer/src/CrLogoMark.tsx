import { VOXEL_HAND_72 } from '../../shared/brand-hand'

/**
 * Cookrew logo mark: the owner's voxel render of a machine hand making a C
 * (shared/brand-hand.ts — the same bytes the site's header and favicon draw).
 * It IS the C of the wordmark: the bar reads the hand, then OOKREW. Ruled
 * 2026-09-06; the two-finger baby hand is in git history.
 */
export function CrLogoMark(): React.JSX.Element {
  return (
    <img
      className="cr-logo-mark"
      src={VOXEL_HAND_72}
      alt="Cookrew logo: a voxel hand making a C"
      draggable={false}
    />
  )
}
