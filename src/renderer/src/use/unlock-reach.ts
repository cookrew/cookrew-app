import { hostOutsideTheMac } from '../../../shared/remote-unlock'
import type { RemoteWhere, UnlockReach } from '../../../shared/remote-access'
import { clientBase } from '../api-base'
import { authStore } from '../auth-gate'

/** A page the Mac served itself, on an address cookrew.dev does not answer for. */
export const onTheMacsOwnPage = (): boolean => clientBase() === '' && !hostOutsideTheMac(window.location.host)

/** Whether a password typed in this browser can reach the Mac (UnlockSheet.tsx · useUnlockWay). */
export function unlockReach(where: RemoteWhere): UnlockReach {
  if (where === 'here' || onTheMacsOwnPage()) return 'ready'
  return authStore().connectCode() === null ? 'unpaired' : 'ready'
}
