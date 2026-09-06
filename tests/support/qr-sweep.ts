/**
 * THE FULL SWEEP: every version 1 to 10 at every correction level, byte mode,
 * from the Python `qrcode` package with no quiet zone.
 *
 * Forty cells, each filled to the exact byte capacity of the version it names,
 * so the case cannot silently slide to a neighbouring version when a table
 * changes. The payload is a real otpauth URL extended with mixed characters —
 * NOT a repeated byte, which makes every error-correction block identical and
 * hides exactly the block-split bugs this sweep exists to catch.
 *
 * The matrices are compared by SHA-256 of their joined rows rather than stored
 * whole: forty symbols up to 57x57 is ninety kilobytes of literal, and the
 * decoder test beside this one is what turns a failed digest into a diagnosis.
 * Two full matrices are kept in qr-fixtures.ts for a readable diff.
 *
 * Regenerate with:
 *   q = qrcode.QRCode(error_correction=LEVEL, border=0)
 *   q.add_data(QRData(TEXT.encode(), mode=MODE_8BIT_BYTE)); q.make(fit=True)
 *   sha256("\n".join("".join("1" if c else "0" for c in r) for r in q.get_matrix()))
 */
export interface QrSweepCase {
  readonly level: 'L' | 'M' | 'Q' | 'H'
  readonly version: number
  readonly text: string
  readonly size: number
  /** SHA-256 of the rows joined with newlines. */
  readonly digest: string
}

export const QR_SWEEP: readonly QrSweepCase[] = [
  {
    level: 'L',
    version: 1,
    text: "otpauth://totp/Co",
    size: 21,
    digest: 'c501398fb0a68ac1935d6ed5281f5e3cea231c49dc5287abff6349c2ef75167a'
  },
  {
    level: 'L',
    version: 2,
    text: "otpauth://totp/Cookrew:drej?secr",
    size: 25,
    digest: '360073ef8d3c37ed0b9b2f42f82619f73f998514074421d289962fd4e54437c7'
  },
  {
    level: 'L',
    version: 3,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJB",
    size: 29,
    digest: '836a1052ab2f66a759d268c88ee11ad1accee9a05eb27c1592fe45130c59ee99'
  },
  {
    level: 'L',
    version: 4,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Coo",
    size: 33,
    digest: 'fbb87058315f5295e6ea12bcd185b23e52e0297be0de60176956768c800803f9'
  },
  {
    level: 'L',
    version: 5,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6",
    size: 37,
    digest: '939d93f6d223612fcf40502132ff5bfd2769994de8e27600a249d1a4a0b71e99'
  },
  {
    level: 'L',
    version: 6,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRt",
    size: 41,
    digest: '4c1bb2371f13f5d04e5d7c6233a89ec7d12ffdf6cec3be2e99962cc9a9b76b58'
  },
  {
    level: 'L',
    version: 7,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYuio",
    size: 45,
    digest: '488948429efa477de6199a675605282590d8edf5673222741aa9f3485f8c0996'
  },
  {
    level: 'L',
    version: 8,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYuiopASDFGHjklzxcvbnm0987654321!$*()+,;:@/",
    size: 49,
    digest: '42776b9d05f90b0eb3046e3be7ccfad05787cbb67c9062b7b91d9a0851fae029'
  },
  {
    level: 'L',
    version: 9,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYuiopASDFGHjklzxcvbnm0987654321!$*()+,;:@/?#[]abcdefghijklmnopqrstuvwxyzotpauth:",
    size: 53,
    digest: '724d95cb17b37d6f463d7b238057bef0443884eb3ccfad3273ad98976d44bf36'
  },
  {
    level: 'L',
    version: 10,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYuiopASDFGHjklzxcvbnm0987654321!$*()+,;:@/?#[]abcdefghijklmnopqrstuvwxyzotpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3P",
    size: 57,
    digest: '5457b4b6295299a1e11835be430ba4a99f05d9b708c6cad33832c6b034ab3509'
  },
  {
    level: 'M',
    version: 1,
    text: "otpauth://totp",
    size: 21,
    digest: 'f45a4d73c34279a2e48188c6281effcad304a071489d3eea63d02b1578706e3c'
  },
  {
    level: 'M',
    version: 2,
    text: "otpauth://totp/Cookrew:dre",
    size: 25,
    digest: '9fcecdd1a81c08792e3da71127dcf2e4579a9112b6329bed0c46f1802248e34d'
  },
  {
    level: 'M',
    version: 3,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3D",
    size: 29,
    digest: '680e4ce8632803a8689593c3db1eb24b90e78a9299339b0bec20899d94e0b890'
  },
  {
    level: 'M',
    version: 4,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHP",
    size: 33,
    digest: 'af5960e6c5f337631b852c3bba52afd7d5f4f05324d31fc118220ace00a4c772'
  },
  {
    level: 'M',
    version: 5,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&a",
    size: 37,
    digest: 'c2b2a570f0deb6a66c8587c28f72fd30b673616697633a05012b3e30c9d3bae8'
  },
  {
    level: 'M',
    version: 6,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6",
    size: 41,
    digest: '20b3c4542175e835ec28d20881e63ee48cc3a3b542869a2cc26d6caab226ecd1'
  },
  {
    level: 'M',
    version: 7,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9",
    size: 45,
    digest: 'e12a474f18c77b68e645b8795329ef75b17a0c9663b9df59cda9b4f840f09fe6'
  },
  {
    level: 'M',
    version: 8,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYu",
    size: 49,
    digest: '88fbb7ea73a4363e60cade0c088515653ba0a0c73f943669986d211f47efae36'
  },
  {
    level: 'M',
    version: 9,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYuiopASDFGHjklzxcvbnm098765432",
    size: 53,
    digest: '4f92033778e828fa433b4b3ea6f4c53b6ce82059a48e27a7461b814ddedef70d'
  },
  {
    level: 'M',
    version: 10,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTYuiopASDFGHjklzxcvbnm0987654321!$*()+,;:@/?#[]abcdefghijklmnopq",
    size: 57,
    digest: '60add14d29c5a44691103653aa582b06293f526f3c84f66443aa4f3648665d03'
  },
  {
    level: 'Q',
    version: 1,
    text: "otpauth://t",
    size: 21,
    digest: '5f8c8f3bc9cf241017cd5f77eb420748eb0060f0e2a7f50bd9caf104cc5f5240'
  },
  {
    level: 'Q',
    version: 2,
    text: "otpauth://totp/Cookr",
    size: 25,
    digest: 'c226a317faf095e88227e933f8e4c2cef73a7d62619319db08d375a2db91a3d8'
  },
  {
    level: 'Q',
    version: 3,
    text: "otpauth://totp/Cookrew:drej?secr",
    size: 29,
    digest: 'd5d5ba8a191544e42eab74d9af15b100c80a20931690918068d9fe34a81b1a51'
  },
  {
    level: 'Q',
    version: 4,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHP",
    size: 33,
    digest: '1690838cb3ce2f89a1cbe58d3d8a1e4e36e9db0acd796dfbe650442ffaadf279'
  },
  {
    level: 'Q',
    version: 5,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPE",
    size: 37,
    digest: 'bade8cbb564794f40823642bdfc4ace62fd0ef76673e11c8cc7b927388a639ef'
  },
  {
    level: 'Q',
    version: 6,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer",
    size: 41,
    digest: 'db3b4744a5bf13e72714b97bb594549361fa33c75b2bee783fa493dd579fd572'
  },
  {
    level: 'Q',
    version: 7,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&alg",
    size: 45,
    digest: 'c92ed47ea86266d52837c7c0d59ce426ef9d91bf8ee3b9a67354636ef7acedc1'
  },
  {
    level: 'Q',
    version: 8,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&p",
    size: 49,
    digest: '534f66af7466dd0b277432aa5cde39e98586aa21f68846492dc6b08ef12efa4d'
  },
  {
    level: 'Q',
    version: 9,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20q",
    size: 53,
    digest: 'c2266d3f4d11142f4b89ba5a62af43896f3e9e2de13a99f330b6852ab17c8938'
  },
  {
    level: 'Q',
    version: 10,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=aZ9-_.~%20qWeRtY1234567890QWERTY",
    size: 57,
    digest: '668a06d84517970705bb632158d6d547e6c53752b29509ab7eb261527a07535c'
  },
  {
    level: 'H',
    version: 1,
    text: "otpauth",
    size: 21,
    digest: 'a27a6963e696c72c22f5319c700c7ace0abcdb1e51d2f404ea70402435851677'
  },
  {
    level: 'H',
    version: 2,
    text: "otpauth://totp",
    size: 25,
    digest: 'd4a62f30ea01071e4e123e297368c1f6047ee3c83f9a2e3de052af93d62d46b7'
  },
  {
    level: 'H',
    version: 3,
    text: "otpauth://totp/Cookrew:d",
    size: 29,
    digest: 'acad8c9e4fc39f97c9f55f5c861564f4f24269d233fc67790d319a2eaae09319'
  },
  {
    level: 'H',
    version: 4,
    text: "otpauth://totp/Cookrew:drej?secret",
    size: 33,
    digest: '5ed41f825e78a033a56e3c8323292c212e7764efbf00e287976608f30188fa5e'
  },
  {
    level: 'H',
    version: 5,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPE",
    size: 37,
    digest: 'e1ea96c8493bfc28265e827378283f0080548f20be1870c06b74b99432a627a2'
  },
  {
    level: 'H',
    version: 6,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3D",
    size: 41,
    digest: '1e1538258ff46086be70f8f86e7c905deaa9b451e56c4f07ed5dd494c994f556'
  },
  {
    level: 'H',
    version: 7,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3",
    size: 45,
    digest: '7c02993086bb2f932dec2bdd4df0bc8cda2d1a4bc09cdfa57f0fa7cd0ef090a7'
  },
  {
    level: 'H',
    version: 8,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&a",
    size: 49,
    digest: 'd3233db44ef6a865469954c84b92c68a6950fd00263b578c63f3b0bcf38931e8'
  },
  {
    level: 'H',
    version: 9,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&",
    size: 53,
    digest: '078a21f2582a9222775e5bb30e225ae0b34964b5cf98d3a1b103d855f91bc82c'
  },
  {
    level: 'H',
    version: 10,
    text: "otpauth://totp/Cookrew:drej?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cookrew&algorithm=SHA1&digits=6&period=30&x=",
    size: 57,
    digest: '72e6ac5b47d2ce374f4f852dd1500e38e9eba2f69c5651b41b12e30839ead943'
  },
]
