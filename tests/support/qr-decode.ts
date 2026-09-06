/**
 * A QR DECODER, WRITTEN FROM THE SPEC AND NOT FROM THE ENCODER.
 *
 * A whole-matrix comparison against a reference proves the encoder agrees with
 * one other implementation. It does not prove the thing anybody actually
 * cares about, which is that a scanner can read the symbol — and it fails in
 * an unhelpfully loud way when the two merely break a mask-selection tie
 * differently, which is a difference no camera can see.
 *
 * So this reads a matrix back the way a scanner does: recover the format
 * information (BCH-corrected), unmask, walk the placement, de-interleave the
 * blocks, and run the Reed-Solomon SYNDROMES to zero before believing a single
 * data byte. A symbol whose syndromes vanish is a symbol whose error
 * correction agrees with its data — which is exactly the property a broken
 * block split, a wrong interleave or a mis-written format strip destroys.
 *
 * Nothing here imports the encoder. The tables and the geometry are typed in
 * from the standard a second time on purpose: a decoder that borrowed the
 * encoder's own idea of where the data goes would agree with it about a wrong
 * answer.
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H'

export type QrDecoded = {
  readonly version: number
  readonly level: QrLevel
  readonly mask: number
  readonly text: string
}

export type QrDecodeFailure = { readonly error: string }

/** ec codewords per block, and [group 1 blocks, group 2 blocks]. */
const BLOCKS: Record<QrLevel, readonly (readonly [number, number, number])[]> = {
  L: [[0, 0, 0], [7, 1, 0], [10, 1, 0], [15, 1, 0], [20, 1, 0], [26, 1, 0],
      [18, 2, 0], [20, 2, 0], [24, 2, 0], [30, 2, 0], [18, 2, 2]],
  M: [[0, 0, 0], [10, 1, 0], [16, 1, 0], [26, 1, 0], [18, 2, 0], [24, 2, 0],
      [16, 4, 0], [18, 4, 0], [22, 2, 2], [22, 3, 2], [26, 4, 1]],
  Q: [[0, 0, 0], [13, 1, 0], [22, 1, 0], [18, 2, 0], [26, 2, 0], [18, 2, 2],
      [24, 4, 0], [18, 2, 4], [22, 4, 2], [20, 4, 4], [24, 6, 2]],
  H: [[0, 0, 0], [17, 1, 0], [28, 1, 0], [22, 2, 0], [16, 4, 0], [22, 2, 2],
      [28, 4, 0], [26, 4, 1], [26, 4, 2], [24, 4, 4], [28, 6, 2]]
}

const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

const ALIGNMENT = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
]

/** Format-field bits → level. The order is the standard's, not the alphabet's. */
const LEVEL_OF: Record<number, QrLevel> = { 0b01: 'L', 0b00: 'M', 0b11: 'Q', 0b10: 'H' }

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
]

// ---------------------------------------------------------------- GF(256) --

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/**
 * The syndromes of one block. All zero means the codeword is a valid
 * Reed-Solomon word — the data and its check bytes agree.
 */
const syndromes = (block: readonly number[], ec: number): number[] =>
  Array.from({ length: ec }, (_, i) =>
    block.reduce((acc, byte) => mul(acc, EXP[i]) ^ byte, 0)
  )

// --------------------------------------------------------------- geometry --

/** Every module a decoder must NOT read as data, from the standard's rules. */
const functionMap = (version: number): boolean[][] => {
  const n = version * 4 + 17
  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const fill = (top: number, left: number, h: number, w: number): void => {
    for (let r = top; r < top + h; r++) {
      for (let c = left; c < left + w; c++) {
        if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true
      }
    }
  }
  // Finders and their separators.
  fill(0, 0, 8, 8)
  fill(0, n - 8, 8, 8)
  fill(n - 8, 0, 8, 8)
  // Timing.
  for (let i = 0; i < n; i++) {
    fn[6][i] = true
    fn[i][6] = true
  }
  // Alignment, minus the three that the finders already own.
  const centres = ALIGNMENT[version]
  for (const row of centres) {
    for (const col of centres) {
      const atFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === n - 7) ||
        (row === n - 7 && col === 6)
      if (atFinder) continue
      fill(row - 2, col - 2, 5, 5)
    }
  }
  // Format strip, both copies, and the always-dark module.
  for (let i = 0; i < 9; i++) {
    fn[8][i] = true
    fn[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    fn[8][n - 1 - i] = true
    fn[n - 1 - i][8] = true
  }
  // Version information.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      fn[Math.floor(i / 3)][n - 11 + (i % 3)] = true
      fn[n - 11 + (i % 3)][Math.floor(i / 3)] = true
    }
  }
  return fn
}

/** The format field, corrected against the 32 legal words. */
const readFormat = (m: boolean[][]): { level: QrLevel; mask: number } | null => {
  const n = m.length
  let raw = 0
  // The copy along column 8 and row 8, read in the standard's bit order.
  for (let i = 0; i < 15; i++) {
    let bit: boolean
    if (i < 6) bit = m[i][8]
    else if (i === 6) bit = m[7][8]
    else if (i === 7) bit = m[8][8]
    else if (i === 8) bit = m[8][7]
    else bit = m[8][14 - i]
    if (bit) raw |= 1 << i
  }
  const bch = (value: number): number => {
    let rest = value << 10
    for (let i = 4; i >= 0; i--) if (rest & (1 << (10 + i))) rest ^= 0x537 << i
    return (((value << 10) | rest) ^ 0x5412) >>> 0
  }
  let best = -1
  let bestDistance = 16
  for (let candidate = 0; candidate < 32; candidate++) {
    const distance = popcount(bch(candidate) ^ raw)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  // Three bit errors is the correction limit of this code; beyond it the field
  // is not "nearly" anything and reading it would be a guess.
  if (best < 0 || bestDistance > 3) return null
  const level = LEVEL_OF[(best >> 3) & 0b11]
  return level === undefined ? null : { level, mask: best & 0b111 }
}

const popcount = (value: number): number => {
  let n = value
  let count = 0
  while (n) {
    count += n & 1
    n >>>= 1
  }
  return count
}

/** The codewords, in placement order, unmasked. */
const readCodewords = (m: boolean[][], mask: number): number[] => {
  const n = m.length
  const fn = functionMap((n - 17) / 4)
  const bits: number[] = []
  let upward = true
  for (let right = n - 1; right >= 1; right -= 2) {
    const pair = right === 6 ? 5 : right
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step
      for (const col of [pair, pair - 1]) {
        if (fn[row][col]) continue
        const dark = m[row][col] !== MASKS[mask](row, col)
        bits.push(dark ? 1 : 0)
      }
    }
    upward = !upward
    if (right === 6) right -= 1
  }
  const codewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  }
  return codewords
}

export const decodeQr = (m: boolean[][]): QrDecoded | QrDecodeFailure => {
  const n = m.length
  if (n < 21 || (n - 17) % 4 !== 0) return { error: `not a QR size: ${n}` }
  const version = (n - 17) / 4
  if (version < 1 || version > 10) return { error: `unsupported version ${version}` }
  if (!m.every((row) => row.length === n)) return { error: 'not square' }

  const format = readFormat(m)
  if (!format) return { error: 'the format information does not decode' }
  const { level, mask } = format

  const [ec, group1, group2] = BLOCKS[level][version]
  const count = group1 + group2
  const data = TOTAL[version] - ec * count
  const shortLength = Math.floor(data / count)

  const stream = readCodewords(m, mask)
  if (stream.length < TOTAL[version]) {
    return { error: `only ${stream.length} codewords, wanted ${TOTAL[version]}` }
  }

  // De-interleave: data first, column-major across blocks, then the ec bytes.
  const lengths = Array.from({ length: count }, (_, i) =>
    i < group1 ? shortLength : shortLength + 1
  )
  const blocks: number[][] = lengths.map(() => [])
  let at = 0
  for (let i = 0; i < Math.max(...lengths); i++) {
    for (let b = 0; b < count; b++) if (i < lengths[b]) blocks[b].push(stream[at++])
  }
  const ecBlocks: number[][] = lengths.map(() => [])
  for (let i = 0; i < ec; i++) {
    for (let b = 0; b < count; b++) ecBlocks[b].push(stream[at++])
  }

  for (let b = 0; b < count; b++) {
    const bad = syndromes([...blocks[b], ...ecBlocks[b]], ec).some((s) => s !== 0)
    if (bad) return { error: `block ${b} of ${count} fails its Reed-Solomon syndromes` }
  }

  // The payload, out of the concatenated data blocks.
  const bytes = blocks.flat()
  const bitAt = (index: number): number => (bytes[index >> 3] >> (7 - (index & 7))) & 1
  const take = (start: number, length: number): number => {
    let value = 0
    for (let i = 0; i < length; i++) value = (value << 1) | bitAt(start + i)
    return value
  }
  const mode = take(0, 4)
  if (mode !== 0b0100) return { error: `mode ${mode.toString(2)} is not byte mode` }
  const countBits = version < 10 ? 8 : 16
  const length = take(4, countBits)
  if (length > bytes.length) return { error: `claims ${length} bytes of ${bytes.length}` }
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = take(4 + countBits + i * 8, 8)
  return { version, level, mask, text: new TextDecoder().decode(out) }
}
