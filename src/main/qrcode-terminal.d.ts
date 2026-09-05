/**
 * The encoder inside `qrcode-terminal`, typed.
 *
 * The package ships the classic Kazuhiko Arase QR implementation in its
 * `vendor/` directory and exports only a terminal printer from its entry
 * point. The printer is no use to a window, but the encoder is exactly the
 * thing a QR needs — so the deep import is declared here rather than a second
 * QR library being added to the tree (see qr-matrix.ts).
 */
declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  class QRCode {
    /** `-1` picks the smallest version the data fits in. */
    constructor(typeNumber: number, errorCorrectLevel: number)
    addData(data: string): void
    make(): void
    getModuleCount(): number
    isDark(row: number, col: number): boolean
  }
  export = QRCode
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  const levels: { L: number; M: number; Q: number; H: number }
  export = levels
}
