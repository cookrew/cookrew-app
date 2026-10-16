import { apiPath } from './api-base'
import { isRemoteMode } from './api'

/**
 * ONE STEP, ONCE: TRUST THIS MAC, AND WI-FI NEEDS NO NAME.
 *
 * The companion reaches the Mac on the LAN by its trusted name, and a phone
 * whose proxy app or resolver redirects that name never gets there — the
 * owner's iPhone sat on the relay at home for a week while the bare address
 * opened at once (2026-10-16). The bare address carries a certificate signed
 * by this Mac's own root (main/cert.ts); a phone that trusts the root once
 * reaches the Mac by IP, and the plane switch moves there by itself
 * (path/plane-switch.ts). This row is where the root is offered.
 *
 * A LINK, not a control that acts: it downloads a profile, and iOS does the
 * rest in Settings. Shown on the relay only — on a direct plane the phone is
 * already where this would take it.
 */
export const TRUST_MAC_COPY = {
  lead: 'Stay off the relay at home: trust this Mac once.',
  steps: 'Install the profile, then turn it on in Settings › General › About › Certificate Trust Settings.',
  link: 'Get the certificate'
} as const

export function TrustMacRow({ state }: { state: string }): React.JSX.Element | null {
  if (!isRemoteMode() || state !== 'RELAY') return null
  return (
    <p className="cr-path-trust">
      <span>{TRUST_MAC_COPY.lead}</span> <span className="cr-path-trust-steps">{TRUST_MAC_COPY.steps}</span>{' '}
      <a className="cr-path-trust-link" href={apiPath('/cookrew-ca.mobileconfig')} rel="noreferrer">
        {TRUST_MAC_COPY.link}
      </a>
    </p>
  )
}
