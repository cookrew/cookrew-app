// Keccak-256, vendored.
//
// WHY VENDORED RATHER THAN INSTALLED: EIP-55 address checksums are a keccak256
// encoding, and node:crypto has SHA3 but not Keccak — they differ by one
// padding byte and agree on nothing. The alternative to having keccak here is
// format-only address validation, which accepts a mistyped-but-well-formed
// address and sends an author's money somewhere unrecoverable.
//
// A dependency was the other option and was rejected for a repo reason, not a
// technical one: linked worktrees here resolve `node_modules` upward to ONE
// shared root, so adding a package mutates the dependency set of every other
// agent's in-flight lane. ~120 lines pinned by published vectors is the
// smaller imposition.
//
// ORIGINAL KECCAK PADDING (0x01), not SHA3's 0x06. Ethereum standardised on
// Keccak before SHA3-256 changed the domain byte, so this is deliberately the
// pre-standard variant. tests/keccak.test.ts pins the empty-string digest,
// which is the vector that catches this exact mistake.
//
// BigInt lanes rather than 32-bit halves: this runs once per publish on a
// 20-byte address, so clarity is worth more than throughput, and the halved
// implementation is where subtle rotation bugs live.

const MASK64 = (1n << 64n) - 1n

/** Round constants for Keccak-f[1600], 24 rounds. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
]

/** Rho rotation offsets, in the order the Pi permutation visits lanes. */
const ROTATIONS: readonly number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
]

/** Pi lane permutation. */
const PI_LANES: readonly number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
]

/** Rate in bytes for a 256-bit digest: (1600 - 2*256) / 8. */
const RATE_BYTES = 136

const rotl = (value: bigint, by: number): bigint =>
  ((value << BigInt(by)) | (value >> BigInt(64 - by))) & MASK64

/** The Keccak-f[1600] permutation, in place over 25 lanes. */
function permute(lanes: bigint[]): void {
  const c = new Array<bigint>(5)
  for (let round = 0; round < 24; round += 1) {
    // Theta
    for (let x = 0; x < 5; x += 1) {
      c[x] = lanes[x] ^ lanes[x + 5] ^ lanes[x + 10] ^ lanes[x + 15] ^ lanes[x + 20]
    }
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
      for (let y = 0; y < 25; y += 5) lanes[y + x] ^= d
    }
    // Rho and Pi
    let carried = lanes[1]
    for (let i = 0; i < 24; i += 1) {
      const target = PI_LANES[i]
      const held = lanes[target]
      lanes[target] = rotl(carried, ROTATIONS[i])
      carried = held
    }
    // Chi
    for (let y = 0; y < 25; y += 5) {
      const row = [lanes[y], lanes[y + 1], lanes[y + 2], lanes[y + 3], lanes[y + 4]]
      for (let x = 0; x < 5; x += 1) {
        lanes[y + x] = row[x] ^ ((row[(x + 1) % 5] ^ MASK64) & row[(x + 2) % 5])
      }
    }
    // Iota
    lanes[0] ^= ROUND_CONSTANTS[round]
  }
}

/** Keccak-256 over arbitrary bytes. */
export function keccak256(message: Uint8Array): Uint8Array {
  const lanes = new Array<bigint>(25).fill(0n)

  // PADDING FIRST, as its own buffer: writing pad bytes into the message's
  // last partial block in place is where an off-by-one silently truncates.
  // pad10*1 with Keccak's 0x01 domain byte — a message that is an exact
  // multiple of the rate gets a WHOLE extra block, which is why the 136-byte
  // vector is pinned in the tests.
  const padded = new Uint8Array(Math.floor(message.length / RATE_BYTES + 1) * RATE_BYTES)
  padded.set(message)
  padded[message.length] = 0x01
  padded[padded.length - 1] |= 0x80

  // Absorb: each rate block XORs into the first 17 lanes, little-endian.
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      let value = 0n
      for (let byte = 7; byte >= 0; byte -= 1) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte])
      }
      lanes[lane] ^= value
    }
    permute(lanes)
  }

  // Squeeze 32 bytes. One rate block is 136 bytes, so a 256-bit digest never
  // needs a second permutation.
  const digest = new Uint8Array(32)
  for (let lane = 0; lane < 4; lane += 1) {
    let value = lanes[lane]
    for (let byte = 0; byte < 8; byte += 1) {
      digest[lane * 8 + byte] = Number(value & 0xffn)
      value >>= 8n
    }
  }
  return digest
}

/** Keccak-256 as lowercase hex, with no `0x` prefix. */
export function keccak256Hex(message: Uint8Array): string {
  return [...keccak256(message)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
