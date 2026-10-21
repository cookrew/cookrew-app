// JUMP CODES: every agent in the fleet gets a short code — a digit 1–9, then a
// letter — so any agent on any machine is two keystrokes plus Enter away even
// when names repeat. Names rarely start with a digit, so a code never fights
// a name search. A code comes from a hash of the agent's key, probing past
// collisions in fleet order, so it stays put while other agents come and go.

const DIGITS = '123456789'
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const SPACE = DIGITS.length * LETTERS.length

export const CODE_PATTERN = /^[1-9][a-z]$/

const codeAt = (i: number) => DIGITS[Math.floor(i / LETTERS.length)] + LETTERS[i % LETTERS.length]

const hash = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** key → code, for keys in fleet order. Past 234 agents the rest get three-character codes. */
export const jumpCodes = (keys: readonly string[]): Map<string, string> => {
  const taken = new Set<number>()
  const out = new Map<string, string>()
  let overflow = 0
  for (const key of keys) {
    if (taken.size >= SPACE) {
      out.set(key, `${codeAt(overflow % SPACE)}${Math.floor(overflow / SPACE) + 1}`)
      overflow += 1
      continue
    }
    let slot = hash(key) % SPACE
    while (taken.has(slot)) slot = (slot + 1) % SPACE
    taken.add(slot)
    out.set(key, codeAt(slot))
  }
  return out
}
