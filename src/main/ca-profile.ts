/**
 * THE PROFILE A PHONE INSTALLS TO TRUST THIS MAC — once, for every address.
 *
 * An iPhone adds a root certificate from a configuration profile: Safari
 * downloads `/cookrew-ca.mobileconfig`, Settings installs it, and General ›
 * About › Certificate Trust Settings turns full trust on. After that the
 * companion on cookrew.dev can fetch `https://192.168.2.40:8643` with no
 * warning, so the LAN plane needs no name, no resolver and no proxy rule
 * (cert.ts explains why that matters on the owner's phone).
 *
 * Only the root's PUBLIC certificate is in here; its key never leaves
 * ~/.cookrew/certs. The identifiers and UUIDs come from the root's own
 * fingerprint, so a second download replaces the first instead of stacking.
 */

import { X509Certificate } from 'node:crypto'

export const CA_PROFILE_PATH = '/cookrew-ca.mobileconfig'
export const CA_PEM_PATH = '/cookrew-ca.pem'
export const CA_PROFILE_TYPE = 'application/x-apple-aspen-config'

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A stable UUID-shaped string out of a hex digest, so the same root is the same profile. */
const uuidOf = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase()

export const caProfile = (caPem: Buffer | string): string => {
  const ca = new X509Certificate(caPem)
  const hex = ca.fingerprint256.replace(/:/g, '').toLowerCase()
  const name = /CN=([^\n,]+)/.exec(ca.subject)?.[1]?.trim() ?? 'Cookrew Local CA'
  const der = ca.raw.toString('base64').replace(/(.{64})/g, '$1\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>cookrew-ca.cer</string>
      <key>PayloadContent</key>
      <data>
${der}
      </data>
      <key>PayloadDescription</key>
      <string>Lets this device open the Cookrew desktop directly on your Wi-Fi.</string>
      <key>PayloadDisplayName</key>
      <string>${xml(name)}</string>
      <key>PayloadIdentifier</key>
      <string>dev.cookrew.ca.${hex.slice(0, 16)}.root</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuidOf(hex)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Trust this Mac's own certificate so Cookrew connects on your Wi-Fi without the cookrew.dev relay. Turn it on in Settings › General › About › Certificate Trust Settings.</string>
  <key>PayloadDisplayName</key>
  <string>Cookrew: ${xml(name)}</string>
  <key>PayloadIdentifier</key>
  <string>dev.cookrew.ca.${hex.slice(0, 16)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuidOf(hex.slice(32))}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`
}
