import type { AccountStatus } from '../../../shared/account-v2'
import { avatarView } from './account-store'

/**
 * THE AVATAR IN THE BRAND GROUP (D1) — the one home of identity.
 *
 * It sits right after the wordmark, at the same 24 px as the mark beside it,
 * so the brand group stays one line. Three states and no fourth:
 *
 *   NO ACCOUNT — a dashed empty circle. It reads as "nobody yet". It never
 *   pulses and never nags: everything on this Mac works without an account
 *   (architecture P4), so an avatar that demanded one would be lying about
 *   what the product needs.
 *
 *   CLAIMED — initials on amber, or the uploaded picture.
 *
 *   A DEVICE WAITING — the same rose badge the BOARD button wears for
 *   attention (.cr-viewseg-badge), because it is the same claim on the eye and
 *   two badge styles for "something needs you" is how a bar stops meaning
 *   anything. The count comes from the status; phase 4 is what can raise it.
 *
 * No modal over the canvas: clicking opens the profile sheet, or — before a
 * name exists — the claim sheet.
 */
export function AccountAvatar({
  status,
  onOpen,
}: {
  status: AccountStatus | null
  onOpen: () => void
}): React.JSX.Element {
  const view = avatarView(status)
  const label = view.state === 'none' ? 'Claim a username' : `Account ${view.title}`
  return (
    <button
      type="button"
      className={`cr-acct-avatar cr-acct-${view.state}`}
      title={view.title}
      aria-label={label}
      onClick={onOpen}
    >
      {view.avatar ? (
        <img className="cr-acct-face" src={view.avatar} alt="" />
      ) : (
        <span className="cr-acct-initials">{view.initials}</span>
      )}
      {view.badge !== null && <span className="cr-viewseg-badge cr-acct-badge">{view.badge}</span>}
    </button>
  )
}
