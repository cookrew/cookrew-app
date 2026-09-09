import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
  bitString,
  context,
  integer,
  octetString,
  oid,
  pem,
  sequence,
  set,
  utf8String
} from './der'

/**
 * THE CERTIFICATE REQUEST THIS MAC SENDS, AND NOTHING ELSE IN IT.
 *
 * `POST /v2/me/desktops/:id/cert {csr}` is gated at the registry by exactly
 * one rule: the request must name `*.<that device id>.<zone>` and no second
 * name (registry/src/names.ts · `check`). So this builder takes the names it
 * is given and writes them; it invents nothing, and there is no "while we are
 * here" field. Every name in a request ends up in a public certificate under
 * cookrew.dev and in the Certificate Transparency logs.
 *
 * EC P-256, SIGNED ECDSA-SHA256. The registry accepts an EC key only on P-256
 * and refuses RSA-PSS outright, because its reader will not guess at a
 * signature algorithm it cannot verify. P-256 is also the smallest handshake
 * a phone will do, which matters on the one link where bytes are scarce.
 *
 * THE PRIVATE KEY NEVER LEAVES THIS PROCESS. It is generated here, written
 * 0600 by name-cert-store.ts, and used only to sign this request and TLS
 * handshakes. There is nothing in a CSR worth stealing, and that is deliberate.
 */

const OID_COMMON_NAME = '2.5.4.3'
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'

/** [2] IMPLICIT IA5String inside GeneralNames — a dNSName and no other kind. */
const GENERAL_NAME_DNS = 2

/** A fresh P-256 pair. The only key type this Mac ever asks a CA to certify. */
export const mintNameKey = (): { privateKey: KeyObject; publicKey: KeyObject } =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

const subject = (commonName: string | null): Buffer =>
  commonName === null
    ? sequence()
    : sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))))

const subjectAltName = (names: readonly string[]): Buffer =>
  sequence(
    oid(OID_SUBJECT_ALT_NAME),
    // The extension's value is its own DER inside an OCTET STRING.
    // IMPLICIT tagging REPLACES the IA5String tag with [2] rather than
    // nesting inside it, so the content is written straight under the context
    // tag. latin1 because a dNSName is ASCII by definition (an international
    // name arrives already punycoded).
    octetString(
      sequence(
        ...names.map((one) => context(GENERAL_NAME_DNS, Buffer.from(one, 'latin1'), false))
      )
    )
  )

export interface CsrInput {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
  /** dNSName SANs, in the order the registry will read them. */
  readonly names: readonly string[]
  /**
   * The subject CN. Absent is fine and preferred — the registry accepts no CN
   * or one equal to the wildcard, and a CN that is a name is a habit from
   * before SANs existed.
   */
  readonly commonName?: string | null
}

/**
 * A PEM certificate request for these names, signed by its own key.
 *
 * Throws only on a key this cannot sign with, which is a programming error
 * here rather than anything a network or a user can cause; every caller in
 * this app builds the input from `mintNameKey`.
 */
export function buildCsr(input: CsrInput): string {
  if (input.names.length === 0) throw new Error('a certificate request must name something')
  const spki = Buffer.from(input.publicKey.export({ type: 'spki', format: 'der' }))
  const info = sequence(
    // Version 0 — the only version a CertificationRequest has ever had.
    integer(0),
    subject(input.commonName ?? null),
    spki,
    context(0, sequence(oid(OID_EXTENSION_REQUEST), set(sequence(subjectAltName(input.names)))))
  )
  // The signature is over the DER of CertificationRequestInfo exactly as it
  // will be sent — the same bytes the registry re-hashes when it checks that
  // the request is signed by its own key.
  const signature = sign('sha256', info, input.privateKey)
  return pem(
    'CERTIFICATE REQUEST',
    sequence(info, sequence(oid(OID_ECDSA_SHA256)), bitString(signature))
  )
}
