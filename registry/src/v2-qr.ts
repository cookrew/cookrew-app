import { qrMatrix } from '../../src/shared/qr'

/**
 * THE QR FOR AN AUTHENTICATOR ENROLMENT.
 *
 * The registry has to hand cookrew.dev something a phone camera can read: the
 * owner's ruling is that /me's ADD shows a QR and then verifies, exactly as
 * the desktop sheet does. The page cannot compute it — the CSP forbids an
 * inline script and no encoder is in the browser bundle — so the matrix comes
 * down with the secret it encodes, on the same private answer.
 *
 * THE APP'S OWN ENCODER, `src/shared/qr.ts`, and not the desktop's
 * `src/main/qr-matrix.ts`. That one wraps `qrcode-terminal`, a runtime
 * dependency the registry does not have and must not gain: this ships as one
 * dependency-free esbuild bundle in a ConfigMap. The shared encoder is pure
 * TypeScript with no imports at all, so it travels into the bundle as source.
 *
 * The SHAPE is the desktop's — rows of '0' and '1' — so both halves of the
 * program describe a QR the same way, and a renderer written for one reads
 * the other. It is also a tenth the size of a JSON array of booleans, on an
 * answer that already carries a secret and is never cached.
 */

/** Rows of '0' and '1', top to bottom, no quiet zone. Empty when it will not fit. */
export function qrRows(text: string): string[] {
  const modules = qrMatrix(text)
  if (modules === null) return []
  return modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
}
