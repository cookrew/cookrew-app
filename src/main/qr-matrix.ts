import QRCode from 'qrcode-terminal/vendor/QRCode/index.js'
import LEVELS from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'

/**
 * A QR AS A MATRIX, for the authenticator sheet (D3).
 *
 * THE APP HAD NO QR COMPONENT. The brief expected the pairing popout's, and
 * there is none: the only QR this tree can draw is the one `cookrew mobile`
 * prints in a TERMINAL, out of the `qrcode-terminal` dependency. So the
 * encoder is reused and the printer is not — this returns the modules, and
 * the renderer paints them as one SVG rect per run (QrCode.tsx).
 *
 * WHY IN MAIN, when the picture is the renderer's. The encoder is a CommonJS
 * package that exists in the tree already; the alternatives were to add a
 * second QR library for the browser half, or to write a Reed-Solomon encoder
 * by hand and hope. Drawing the matrix here costs one field on an answer the
 * renderer was already fetching, and the secret it encodes was crossing that
 * same bridge anyway.
 *
 * THE FILE, NOT THE DIRECTORY, in both imports. Main is bundled as ESM (the
 * package is `type: module`), and Node's ESM resolver does not do directory
 * indexes or extension guessing — `vendor/QRCode` resolves under vitest and
 * then throws ERR_UNSUPPORTED_DIR_IMPORT in the built app, which is a crash
 * at boot rather than a failed QR.
 *
 * ERROR CORRECTION M, not L: an otpauth URI is scanned once, off a screen,
 * usually at an angle, by a phone camera that is also being held over a
 * keyboard. M is what every other authenticator enrolment uses.
 */

/** Rows of '0' and '1', top to bottom. Length equals the module count. */
export function qrMatrix(text: string): readonly string[] {
  if (text.length === 0) return []
  const code = new QRCode(-1, LEVELS.M)
  code.addData(text)
  code.make()
  const size = code.getModuleCount()
  const rows: string[] = []
  for (let row = 0; row < size; row += 1) {
    let line = ''
    for (let column = 0; column < size; column += 1) line += code.isDark(row, column) ? '1' : '0'
    rows.push(line)
  }
  return rows
}
